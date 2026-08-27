// Interior builder — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/interior.ts
// (types stripped only; logic, constants and comments unchanged).
// Adaptation: the barrier ShaderMaterial carries logdepthbuf includes because
// this project's renderer runs with logarithmicDepthBuffer enabled.
import * as THREE from 'three';
import {
  buildLoft, mergeGeos, mirrorX, xf, mat, sectionAt, sampleSection,
  isSideEdge, isBellyEdge, sweepProfile, rectProfile, RING,
} from '../loft.js';
import { bevelBox, lathe, greebleField, frameRect, conduit } from '../prims.js';
import { buildCockpit } from './cockpit/index.js';
import { Surf } from './surface.js';
import { rack, crate, grating, recess, bolts } from './fittings.js';



class Bucket {
  constructor() {
    this.m = new Map();
  }
  add(key, geo) {
    let a = this.m.get(key);
    if (!a) this.m.set(key, (a = []));
    a.push(geo);
  }
  addSym(key, geo) { this.add(key, geo); this.add(key, mirrorX(geo)); }
  /**
   * `shadows` decides whether this batch takes part in the shadow pass.
   *
   * It was hard-coded false for the whole interior, which is most of why the
   * cabin read flat next to TLS: every part was lit and nothing occluded
   * anything, so no object was ever seated in the room.  The shells are
   * receive-only — a liner casting onto itself is a full extra pass for
   * nothing — and the furniture both casts and receives.
   */
  flush(parent, mats, shadows = 'both') {
    for (const [k, list] of this.m) {
      const mesh = new THREE.Mesh(mergeGeos(list), mats[k]);
      const shell = k === 'liner' || k === 'deck' || k === 'hullDark';
      mesh.castShadow = shadows === 'both' && !shell;
      mesh.receiveShadow = shadows !== 'none';
      mesh.name = 'int-' + k;
      parent.add(mesh);
    }
    this.m.clear();
  }
}

/** flat deck panel, generously overlapping the wall shells so no seam can open */
function floorStrip(z0, z1, hw, y = 0, step = 0.4) {
  const P = [];
  const U = [];
  const push = (x, z) => { P.push(x, y, z); U.push(x * 0.55, z * 0.55); };
  const n = Math.max(2, Math.ceil((z1 - z0) / step));
  for (let i = 0; i < n; i++) {
    const za = z0 + ((z1 - z0) * i) / n;
    const zb = z0 + ((z1 - z0) * (i + 1)) / n;
    const wa = hw(za), wb = hw(zb);
    /* WINDING FACES UP.
       This used to be (-wa,za) (wa,za) (wb,zb), whose cross product is
       (0, -2*wa*(zb-za), 0) — straight DOWN — while the normal attribute
       below was written as +Y.  The deck material is FrontSide, so the floor
       was culled when seen from above and invisible to the raycaster: from
       the flight deck you were looking through the floor at the belly liner
       0.8 m below, which is the "一整面直接就消失" in the report.  Measured
       with tools/deck.mjs: 39 of 279 downward rays from walk height passed
       through the deck before the fix, 0 after. */
    push(-wa, za); push(wb, zb); push(wa, za);
    push(-wa, za); push(-wb, zb); push(wb, zb);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  const N = new Float32Array(P.length);
  for (let i = 1; i < N.length; i += 3) N[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  return g;
}

function bulkhead(ring, z, hole, facesFwd = false) {
  const shape = new THREE.Shape();
  shape.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i].x, ring[i].y);
  shape.closePath();
  if (hole) {
    const { x, y0, y1, r } = hole;
    const h = new THREE.Path();
    h.moveTo(-x + r, y0);
    h.lineTo(x - r, y0);
    h.quadraticCurveTo(x, y0, x, y0 + r);
    h.lineTo(x, y1 - r);
    h.quadraticCurveTo(x, y1, x - r, y1);
    h.lineTo(-x + r, y1);
    h.quadraticCurveTo(-x, y1, -x, y1 - r);
    h.lineTo(-x, y0 + r);
    h.quadraticCurveTo(-x, y0, -x + r, y0);
    shape.holes.push(h);
  }
  const g = new THREE.ShapeGeometry(shape, 10);
  g.translate(0, 0, z);
  /* A ShapeGeometry is wound in the XY plane, so its face normal is +Z: it
     faces AFT.  That is right for the forward bulkhead, which the cabin sees
     from behind, and wrong for the aft one, which the cabin sees from in
     front — tools/holes.mjs counted 22 rays hitting the aft bulkhead from
     behind.  `facesFwd` reverses the winding and the normals together. */
  if (facesFwd) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 9) {
      for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
    }
    for (let i = 2; i < n.length; i += 3) n[i] = -n[i];
  }
  return g.toNonIndexed();
}

export function buildInterior(M, def) {
  const group = new THREE.Group();
  group.name = 'interior';
  const SHIP = def.dims, HULL = def.hull, CABIN = def.cabin;
  /* the cabin liner as a surface, so wall fittings follow the hull by
     construction — the same discipline the flight deck uses */
  const CABIN_SKIN = new Surf(CABIN, 0.06);
  const B = new Bucket();
  const mats = M;
  M.liner.side = THREE.DoubleSide;

  const addScreen = (w, h, m, idx) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.screens[idx % M.screens.length]);
    mesh.applyMatrix4(m);
    group.add(mesh);
  };

  /* ================= SHELLS ================= */
  const cockpitSpan = (a, b) => a >= SHIP.canopyFront - 1e-4 && b <= SHIP.bulkheadZ + 1e-4;
  B.add('liner', buildLoft(HULL, {
    edge: (e) => isSideEdge(e) || isBellyEdge(e), span: cockpitSpan,
    offset: -0.14, flipWinding: false, uvScale: 1.6,
  }));
  B.add('liner', buildLoft(CABIN, { flipWinding: false, uvScale: 1.6 }));

  /* forward bulkhead: literally the hull cross-section at the canopy root */
  const fwd = HULL.filter((s) => s.at >= SHIP.canopyFront - 1e-4);
  B.add('hullDark', buildLoft(fwd, { edge: () => true, span: () => false, capStart: true, flipWinding: false }));

  /* decks */
  B.add('deck', floorStrip(SHIP.canopyFront, SHIP.bulkheadZ, (z) => sectionAt(HULL, z).w - 0.08));
  B.add('deck', floorStrip(SHIP.bulkheadZ, SHIP.holdEndZ, (z) => sectionAt(CABIN, z).w + 0.06));

  /* ================= COCKPIT (dedicated module) ================= *
   *  The cockpit owns the canopy glazing, the roof over the pilot's head,
   *  the glareshield, the overhead panel and the nose-bay closure.  All of
   *  those used to be duplicated here against a stale eye point. */
  const cockpit = buildCockpit(M, def);
  group.add(cockpit.group);

  /* ================= PILOT SEAT ================= *
   *  Rebuilt as one closed assembly standing on the deck.
   *
   *  The previous seat was a base plate, a narrow 0.30 m post, two thin side
   *  rails and a pan floating above them — so from behind you looked STRAIGHT
   *  THROUGH the gap between the deck and the pan, and the whole thing read
   *  as hovering.  Contact shadow cannot fix that; there was nothing there to
   *  shadow.  What a seat needs is a continuous silhouette from the floor to
   *  the pan: a plinth on the deck, a closed pedestal box, and a pan whose
   *  underside is a real face.  The rails and the recline mechanism sit ON
   *  that, as detail, not as the structure.
   * -------------------------------------------------------------------- */
  {
    const sz = SHIP.seatZ;
    const RAKE = 0.245;                       // backrest recline, radians

    /* ---- deck rails: the seat slides on these, and they are the reason
       the assembly is allowed to be narrower than its footprint ---- */
    for (const sx of [-1, 1]) {
      B.add('darkMetal', xf(bevelBox(0.09, 0.07, 0.92, 0.015), mat(sx * 0.30, 0.035, sz + 0.02)));
      for (let i = 0; i < 5; i++) {
        B.add('brushed', xf(bevelBox(0.12, 0.035, 0.05, 0.01), mat(sx * 0.30, 0.072, sz - 0.36 + i * 0.19)));
      }
    }
    /* ---- plinth: closed, sits ON the deck, toe recess at the front ---- */
    B.add('darkMetal', xf(bevelBox(0.60, 0.10, 0.66, 0.02), mat(0, 0.05, sz + 0.02)));
    B.add('trim', xf(bevelBox(0.52, 0.16, 0.58, 0.02), mat(0, 0.16, sz + 0.02)));
    /* ---- pedestal: ONE closed column, plinth to pan.  This is the part
       that was missing, and it is why the seat now has a silhouette. ---- */
    B.add('trim', xf(bevelBox(0.44, 0.34, 0.50, 0.024), mat(0, 0.41, sz + 0.01)));
    B.add('darkMetal', xf(bevelBox(0.47, 0.05, 0.53, 0.012), mat(0, 0.585, sz + 0.01)));
    /* the height-adjust screw and its shroud, on the column's aft face */
    B.add('brushed', xf(new THREE.CylinderGeometry(0.035, 0.035, 0.30, 12), mat(0, 0.40, sz - 0.29)));
    B.add('rubber', xf(new THREE.CylinderGeometry(0.05, 0.055, 0.10, 12), mat(0, 0.30, sz - 0.29)));
    B.add('darkMetal', xf(greebleField(0.36, 0.30, 5, 91, 0.035), mat(0, 0.245, sz - 0.30, Math.PI / 2, 0, 0)));

    /* ---- seat pan: closed box, not a slab on posts ---- */
    B.add('seat', xf(bevelBox(0.62, 0.17, 0.64, 0.05), mat(0, 0.685, sz - 0.06)));
    B.add('seatTrim', xf(bevelBox(0.56, 0.04, 0.58, 0.02), mat(0, 0.775, sz - 0.06)));
    /* side bolsters, tied to both the pan and the backrest */
    B.addSym('seat', xf(bevelBox(0.10, 0.22, 0.60, 0.04), mat(0.33, 0.79, sz - 0.06)));

    /* ---- backrest, on the recline ---- */
    B.add('seat', xf(bevelBox(0.60, 1.00, 0.16, 0.05), mat(0, 1.26, sz + 0.30, RAKE)));
    B.addSym('seat', xf(bevelBox(0.11, 0.92, 0.21, 0.04), mat(0.33, 1.24, sz + 0.26, RAKE)));
    B.add('seatTrim', xf(bevelBox(0.50, 0.92, 0.05, 0.02), mat(0, 1.26, sz + 0.22, RAKE)));
    /* lumbar ribs, so the back is not one smooth slab */
    for (let i = 0; i < 4; i++) {
      B.add('seatTrim', xf(bevelBox(0.44, 0.05, 0.03, 0.008), mat(0, 0.95 + i * 0.20, sz + 0.205 - i * 0.05, RAKE)));
    }
    /* the recline frame BEHIND the backrest, so it has visible structure */
    B.addSym('darkMetal', xf(bevelBox(0.06, 0.98, 0.06, 0.014), mat(0.30, 1.24, sz + 0.40, RAKE)));
    B.add('darkMetal', xf(bevelBox(0.62, 0.06, 0.06, 0.014), mat(0, 1.72, sz + 0.52, RAKE)));
    B.addSym('brushed', xf(new THREE.CylinderGeometry(0.028, 0.028, 0.10, 10).rotateZ(Math.PI / 2), mat(0.30, 0.80, sz + 0.24)));

    /* ---- headrest ---- */
    B.add('seat', xf(bevelBox(0.38, 0.28, 0.15, 0.05), mat(0, 1.84, sz + 0.45, RAKE)));
    B.addSym('brushed', xf(new THREE.CylinderGeometry(0.014, 0.014, 0.14, 8), mat(0.10, 1.68, sz + 0.415, RAKE)));

    /* ---- armrests: rooted in the backrest, not floating beside it ---- */
    for (const sx of [-1, 1]) {
      B.add('darkMetal', xf(bevelBox(0.07, 0.22, 0.09, 0.016), mat(sx * 0.38, 1.02, sz + 0.20, RAKE)));
      B.add('seat', xf(bevelBox(0.11, 0.09, 0.44, 0.03), mat(sx * 0.38, 0.90, sz - 0.06)));
      B.add('seatTrim', xf(bevelBox(0.09, 0.03, 0.38, 0.01), mat(sx * 0.38, 0.95, sz - 0.06)));
    }

    /* ---- five-point harness: the cue that says "this is flown in" ---- */
    for (const sx of [-1, 1]) {
      B.add('seatTrim', xf(bevelBox(0.075, 0.86, 0.025, 0.008), mat(sx * 0.17, 1.28, sz + 0.20, RAKE)));
      B.add('seatTrim', xf(bevelBox(0.075, 0.30, 0.025, 0.008), mat(sx * 0.19, 0.80, sz - 0.30, 1.35)));
      B.add('brushed', xf(bevelBox(0.05, 0.05, 0.02, 0.006), mat(sx * 0.17, 0.86, sz - 0.16, 1.35)));
    }
    B.add('brushed', xf(bevelBox(0.13, 0.10, 0.05, 0.014), mat(0, 0.80, sz - 0.20, 1.1)));
  }

  /* The overhead panel that used to be here is part of the cockpit module
     now: it belongs under the solid roof the new glazing layout creates,
     and having two of them at two different datums was one of the ways the
     old flight deck interpenetrated. */

  /* ================= BULKHEAD & DOORWAY ================= */
  {
    const ring = sampleSection(sectionAt(HULL, SHIP.bulkheadZ));
    B.add('liner', bulkhead(ring, SHIP.bulkheadZ, { x: 0.98, y0: -0.05, y1: 2.16, r: 0.3 }));
    const fr = [new THREE.Vector3(-0.98, 0.0, SHIP.bulkheadZ)];
    for (let i = 0; i <= 24; i++) {
      const a = Math.PI * (i / 24);
      fr.push(new THREE.Vector3(-Math.cos(a) * 0.98, 1.86 + Math.sin(a) * 0.3, SHIP.bulkheadZ));
    }
    fr.push(new THREE.Vector3(0.98, 0.0, SHIP.bulkheadZ));
    B.add('trim', sweepProfile(fr, fr.map(() => new THREE.Vector3(0, 0, 1)), rectProfile(0.075, 0.1, 0.3)));
    for (const sx of [-1, 1]) {
      B.add('darkMetal', xf(bevelBox(0.22, 2.12, 0.1, 0.03), mat(sx * 1.06, 1.04, SHIP.bulkheadZ - 0.02)));
      B.add('hullAccent', xf(bevelBox(0.1, 0.5, 0.11, 0.02), mat(sx * 1.06, 1.6, SHIP.bulkheadZ - 0.03)));
      B.add('seat', xf(bevelBox(0.5, 0.1, 0.44, 0.04), mat(sx * 1.62, 0.52, SHIP.bulkheadZ - 0.36)));
      B.add('seat', xf(bevelBox(0.5, 0.72, 0.1, 0.04), mat(sx * 1.62, 0.9, SHIP.bulkheadZ - 0.13)));
      B.add('darkMetal', xf(bevelBox(0.1, 0.5, 0.1, 0.02), mat(sx * 1.62, 0.26, SHIP.bulkheadZ - 0.36)));
    }
    B.add('glowGreen', xf(bevelBox(0.5, 0.03, 0.02, 0.005), mat(0, 2.2, SHIP.bulkheadZ - 0.08)));
    B.addSym('darkMetal', xf(greebleField(0.6, 0.5, 6, 66, 0.04), mat(1.55, 1.55, SHIP.bulkheadZ - 0.09, -Math.PI / 2)));
  }

  /* ================= CABIN STRUCTURE ================= */
  const rib = (z) => {
    const ring = sampleSection(sectionAt(CABIN, z));
    const order = [];
    for (let i = 25; i < RING; i++) order.push(i);
    for (let i = 0; i <= 24; i++) order.push(i);
    const path = [];
    const ups = [];
    for (const j of order) {
      const p = ring[j];
      if (p.y < 0.06) continue;
      path.push(new THREE.Vector3(p.x, p.y, z));
      ups.push(new THREE.Vector3(-p.x, -p.y + 1.1, 0).normalize());
    }
    if (path.length > 3) B.add('trim', sweepProfile(path, ups, rectProfile(0.085, 0.055, 0.3)));
  };
  for (let z = -4.85; z < 6.05; z += 1.1) rib(z);

  /* ---- WALL MOUNT FRAME -------------------------------------------- *
   *  Surf.place() hands back a frame whose +Y is the OUTWARD normal, and its
   *  `off` is measured outward too — so for a fitting inside the cabin both
   *  of those run the wrong way, and every wall unit in here was built with
   *  them anyway.
   *
   *  What that produced, measured against the liner: rack() puts its carcass
   *  at +Y (depth/2 + 0.02) = 0.12 m OUTWARD of the point it is given, so a
   *  0.20 m deep cabinet spanned 0.16 m behind the liner and 0.04 m in front
   *  of it.  Four centimetres of a twenty-centimetre unit — which is why the
   *  corridor's equipment read as thin plates stuck flat to the wall rather
   *  than as hardware, and why their recessed faces and louvres were nowhere
   *  to be seen: those sit at +0.22, a fifth of a metre inside the wall.
   *
   *  `wall()` fixes it once, for every caller: it lands on the liner surface
   *  and then turns the frame over about its own X axis, so +Y points INTO
   *  the cabin.  Rotation, not negation — a negated column makes the basis
   *  left-handed and turns every solid placed with it inside out (see the
   *  note in Surf.frame).  R_x(PI) is diag(1, -1, -1): +Y and +Z both flip,
   *  determinant stays +1.
   */
  const FLIP = new THREE.Matrix4().makeRotationX(Math.PI);
  const wall = (z, ri, stand = 0) =>
    CABIN_SKIN.place(z, ri, CABIN_SKIN.inset - stand, 0).multiply(FLIP);

  for (const sx of [-1, 1]) {
    const path = [];
    for (let z = -5.2; z <= 6.05; z += 0.3) {
      const s = sectionAt(CABIN, z);
      path.push(new THREE.Vector3(sx * s.wTop * 0.72, s.yTop - 0.1, z));
    }
    const ups = path.map(() => new THREE.Vector3(0, -1, 0));
    B.add('trim', sweepProfile(path, ups, rectProfile(0.09, 0.05, 0.3)));
    B.add('strip', sweepProfile(path.map((p) => p.clone().add(new THREE.Vector3(0, -0.055, 0))), ups,
      rectProfile(0.06, 0.012, 0.2)));
    const pts = [];
    for (let z = -5.2; z <= 6.0; z += 1.0) {
      pts.push(new THREE.Vector3(sx * (sectionAt(CABIN, z).wBot - 0.05), 0.17, z));
    }
    B.add('darkMetal', conduit(pts, 0.055, 8));
    B.add('copper', conduit(pts.map((p) => p.clone().add(new THREE.Vector3(0, 0.12, 0))), 0.03, 7));
  }

  /* corridor fittings: wall racks that follow the hull, on the shared
     surface, instead of slabs floating at waist height.
     Two per side, not three: at 1.15 m of chord each, three ran from
     z -5.475 to -2.025 — the forward one straight through the bulkhead at
     -5.40, and the run left no clear wall anywhere for a display. */
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const z = -4.75 + i * 1.15;
      rack(B, wall(z, sx * 11), 0.86, 1.15, 0.20, i * 3 + (sx > 0 ? 1 : 0));
    }
    /* a continuous kick rail and a grab rail along the corridor, both swept
       along the liner so they cannot part from it.  `off` is OUTWARD, so a
       rail that is to stand in the cabin needs inset MINUS its standoff; at
       +0.07 the grab rail sat 1 cm behind the liner with 1.4 cm of itself
       showing, i.e. a flush strip you cannot get a hand behind. */
    const kick = CABIN_SKIN.runZ(sx * 14, -5.25, -0.4, 0.3, CABIN_SKIN.inset - 0.035);
    B.add('brushed', sweepProfile(kick.path, kick.ups, rectProfile(0.05, 0.02, 0.35)));
    const grab = CABIN_SKIN.runZ(sx * 8, -5.0, -0.6, 0.3, CABIN_SKIN.inset - 0.10);
    B.add('brushed', sweepProfile(grab.path, grab.ups, rectProfile(0.024, 0.024, 0.4)));
    for (let z = -4.8; z < -0.6; z += 1.05) {
      B.add('darkMetal', xf(bevelBox(0.05, 0.075, 0.06, 0.01), wall(z, sx * 8, 0.038)));
    }
  }
  /* Corridor status displays.
     Two things were wrong and only the first had been fixed.  They used to be
     at an absolute x of +/-1.29 where the wall is at 1.54, so each floated a
     quarter of a metre off the liner — the "盘面悬浮在空中" in the report.
     Mounting them through CABIN_SKIN put them on the wall, and then they
     disappeared completely, which is the follow-up report: the screen plane's
     normal is its local +Z, rotateX(-PI/2) sends that to +Y, and +Y on this
     frame is the OUTWARD normal — so the display was facing into the hull and
     being backface-culled.  The screens material is FrontSide (it is a
     display; it has a front), so there is nothing to see from the cabin.
     Now built on wall(), whose +Y already points inboard. */
  for (const sx of [-1, 1]) {
    const m = wall(-2.30, sx * 10);
    /* THE WALL CURVES AND THE PANEL DOES NOT.
       Over the 0.25 m half-width the first version had, the corridor's
       shoulder rises about 3 cm inboard of the tangent plane at ring 10 — so
       with the housing's back face ON the liner, the wall ate the top third
       of it and the panel read as half sunk into the plating.  Two changes,
       both cheap: the body is narrower across the ring (the direction that
       curves), and it is carried on a small bracket plate 5 cm off the liner,
       which is more clearance than the sag can use up.  The bracket is small
       enough that its own sag is under 5 mm. */
    B.add('darkMetal', xf(bevelBox(0.20, 0.05, 0.34, 0.010), m.clone().multiply(mat(0, 0.025, 0))));
    bolts(B, m.clone().multiply(mat(0, 0.006, 0)), 0.17, 0.30, 0.014);
    B.add('trim', xf(bevelBox(0.40, 0.075, 0.58, 0.014), m.clone().multiply(mat(0, 0.0875, 0))));
    B.add('blackMetal', xf(bevelBox(0.34, 0.025, 0.52, 0.006), m.clone().multiply(mat(0, 0.137, 0))));
    B.add('brushed', xf(frameRect(0.32, 0.50, 0.02, 0.024), m.clone().multiply(mat(0, 0.146, 0))));
    /* spin the frame a quarter turn first so the picture's "up" runs up the
       WALL and its width runs along the ship, then stand the plane up out of
       the surface plane */
    addScreen(0.46, 0.28, m.clone()
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
      .multiply(mat(0, 0.155, 0))
      .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)), sx > 0 ? 4 : 5);
    B.add('glowGreen', xf(new THREE.SphereGeometry(0.013, 8, 6), m.clone().multiply(mat(0.17, 0.14, -0.24))));
    B.add('hullAccent', xf(bevelBox(0.13, 0.008, 0.05, 0.004), m.clone().multiply(mat(-0.14, 0.14, -0.25))));
  }

  /* the corridor and throat get open grating: a deck you can see through to
     a tray below is the one thing a tiling map cannot fake */
  grating(B, -1.05, 1.05, -5.1, 1.0);
  grating(B, -1.35, 1.35, 1.0, 5.9);

  /* hold fittings: racks on the wall, a workbench with legs, and stowage */
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      rack(B, wall(0.5 + i * 1.35, sx * 11), 1.02, 1.30, 0.22, 200 + i * 5 + (sx > 0 ? 1 : 0));
    }
    /* workbench: a top on two end frames with a lower shelf, not a slab */
    const bz = 4.3;
    B.add('trim', xf(bevelBox(0.62, 0.07, 1.62, 0.014), mat(sx * 1.72, 0.94, bz)));
    B.add('brushed', xf(frameRect(0.58, 1.58, 0.022, 0.028), mat(sx * 1.72, 0.985, bz)));
    for (const sz of [-1, 1]) {
      B.add('darkMetal', xf(bevelBox(0.56, 0.90, 0.075, 0.012), mat(sx * 1.72, 0.47, bz + sz * 0.74)));
      bolts(B, mat(sx * 1.72, 0.03, bz + sz * 0.74), 0.5, 0.06, 0.018);
    }
    B.add('blackMetal', xf(bevelBox(0.54, 0.035, 1.5, 0.008), mat(sx * 1.72, 0.36, bz)));
    recess(B, mat(sx * 1.72, 0.98, bz - 0.5), 0.36, 0.30, 'trim', 'darkMetal', 0.018);
    /* tool board above the bench, on the wall surface */
    rack(B, wall(bz, sx * 8), 0.9, 0.62, 0.14, 400 + (sx > 0 ? 1 : 0));
  }
  crate(B, -1.30, 0.32, 1.10, 1.12, 1.34, 3001);
  crate(B, 1.30, 0.32, 1.10, 1.12, 1.34, 3002, 0.04);
  crate(B, 1.32, 1.98, 1.16, 0.78, 1.10, 3003, -0.05);
  crate(B, -1.34, 2.02, 0.90, 1.42, 0.92, 3004, 0.07);
  {
    /* Ceiling service run down the hold.
       This is the surface directly under the row of ceiling lamps, so it is
       the brightest large object in the aft bay — tools/blank.mjs measured it
       at 22.5% of the frame with a mean of 152 and no detail, which is
       precisely the "empty face" complaint.  A continuous swept beam cannot
       be anything else: it has no joints, no ends and no equipment on it.
       So it is built as a RUN OF SECTIONS with visible joints, a recessed
       cable channel underneath, and junction boxes at intervals. */
    const z0 = -0.6, z1 = 5.9;
    const segs = 7;
    for (let i = 0; i < segs; i++) {
      const a = z0 + ((z1 - z0) * i) / segs + 0.035;
      const b = z0 + ((z1 - z0) * (i + 1)) / segs - 0.035;
      const mid = (a + b) / 2, len = b - a;
      /* the section itself, and a flange either side so it reads as extruded */
      B.add('darkMetal', xf(bevelBox(0.17, 0.11, len, 0.014), mat(0, 2.40, mid)));
      B.addSym('trim', xf(bevelBox(0.035, 0.05, len, 0.008), mat(0.10, 2.42, mid)));
      /* recessed channel in the underside: the shadow line is what stops a
         beam reading as a painted stripe on the ceiling */
      B.add('blackMetal', xf(bevelBox(0.075, 0.03, len - 0.05, 0.006), mat(0, 2.335, mid)));
      /* the joint collar between sections */
      B.add('trim', xf(bevelBox(0.20, 0.13, 0.055, 0.010), mat(0, 2.40, b + 0.035)));
      for (const sx of [-1, 1]) {
        B.add('brushed', xf(new THREE.CylinderGeometry(0.012, 0.014, 0.016, 8).rotateZ(Math.PI / 2), mat(sx * 0.10, 2.40, b + 0.035)));
      }
    }
    /* junction boxes and a conduit pair riding the beam's flanks */
    for (const z of [0.5, 2.6, 4.7]) {
      B.add('trim', xf(bevelBox(0.24, 0.16, 0.30, 0.014), mat(0, 2.44, z)));
      B.add('darkMetal', xf(greebleField(0.20, 0.26, 5, 970 + z, 0.028), mat(0, 2.355, z, Math.PI)));
      B.add('glowGreen', xf(bevelBox(0.03, 0.008, 0.05, 0.002), mat(0.07, 2.352, z)));
    }
    for (const sx of [-1, 1]) {
      const cp = [];
      for (let z = -0.4; z <= 5.7; z += 0.6) cp.push(new THREE.Vector3(sx * 0.135, 2.355, z));
      B.add('rubber', conduit(cp, 0.022, 6));
    }
    for (let z = -0.2; z < 5.9; z += 1.2) B.add('darkMetal', xf(bevelBox(0.16, 0.16, 0.14, 0.03), mat(0, 2.48, z)));
    B.add('darkMetal', xf(bevelBox(0.3, 0.26, 0.4, 0.04), mat(0, 2.24, 3.2)));
    B.add('hullAccent', xf(bevelBox(0.32, 0.06, 0.42, 0.02), mat(0, 2.1, 3.2)));
  }
  for (const sx of [-1, 1]) {
    const pts = [new THREE.Vector3(sx * 1.55, 0.015, -0.8), new THREE.Vector3(sx * 1.55, 0.015, 5.95)];
    B.add('trim', sweepProfile(pts, pts.map(() => new THREE.Vector3(0, 1, 0)), rectProfile(0.075, 0.025, 0.3)));
  }

  /* ================= AFT BULKHEAD + RAMP APERTURE ================= */
  {
    const ring = sampleSection(sectionAt(CABIN, SHIP.holdEndZ));
    B.add('liner', bulkhead(ring, SHIP.holdEndZ, { x: SHIP.rampHalfW, y0: 0.0, y1: SHIP.rampTopY, r: 0.16 }, true));
    const corners = [
      new THREE.Vector3(-SHIP.rampHalfW, 0, SHIP.holdEndZ),
      new THREE.Vector3(-SHIP.rampHalfW, SHIP.rampTopY, SHIP.holdEndZ),
      new THREE.Vector3(SHIP.rampHalfW, SHIP.rampTopY, SHIP.holdEndZ),
      new THREE.Vector3(SHIP.rampHalfW, 0, SHIP.holdEndZ),
    ];
    for (let i = 0; i < 3; i++) {
      B.add('trim', sweepProfile([corners[i], corners[i + 1]],
        [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1)], rectProfile(0.1, 0.13, 0.3)));
    }
    for (const sx of [-1, 1]) {
      B.add('hullAccent', xf(bevelBox(0.12, 2.2, 0.05, 0.01), mat(sx * (SHIP.rampHalfW + 0.19), 1.1, SHIP.holdEndZ - 0.09)));
      B.add('darkMetal', xf(greebleField(0.34, 1.3, 8, 400 + sx, 0.045), mat(sx * 2.03, 1.2, SHIP.holdEndZ - 0.11, 0, 0, sx * Math.PI / 2)));
    }
    B.add('liner', xf(bevelBox(0.46, 0.6, 0.16, 0.03), mat(-2.02, 1.35, SHIP.holdEndZ - 0.22, 0, 0.28, 0)));
    /* The plate faces the HOLD, so its normal is -Z.  A PlaneGeometry's
       normal is +Z, so the yaw is PI + the carrier's cant, not the cant on
       its own — at 0.28 the display was showing the hold its back face and,
       being FrontSide like every screen, showing nothing at all. */
    addScreen(0.32, 0.23, mat(-2.0, 1.45, SHIP.holdEndZ - 0.31, 0, Math.PI + 0.28, 0), 1);
    B.add('glowRed', xf(new THREE.SphereGeometry(0.035, 8, 6), mat(-2.0, 1.14, SHIP.holdEndZ - 0.31)));
    B.add('darkMetal', xf(lathe([[0.14, 0], [0.16, 0.06], [0.1, 0.09]], 12), mat(0, SHIP.rampTopY - 0.05, SHIP.holdEndZ + 0.45, Math.PI)));
    B.add('glowAmber', xf(new THREE.SphereGeometry(0.05, 10, 8), mat(0, SHIP.rampTopY - 0.12, SHIP.holdEndZ + 0.45)));
  }

  /* ================= CONTAINMENT FIELD ================= *
   *  IT GOES IN THE DOORWAY, NOT IN THE RAMP.
   *
   *  There are two apertures back here and the field was in the wrong one.
   *  The HULL's ventral cut is a 45-degree opening from the hinge at
   *  (rampHingeY, rampHingeZ) up to (rampTopY, rampTopZ) — that one is closed
   *  by the ramp LEAF itself, which is the thing hinged to it.  The PRESSURE
   *  BULKHEAD's door is the rectangle at z = holdEndZ, y 0..rampTopY — and a
   *  force field standing in for a door belongs there, in the plane of the
   *  pressure boundary, like every airlock membrane ever drawn.
   *
   *  Putting it in the 45-degree plane instead had three consequences, all
   *  of them reported:
   *
   *    - it lay OVER the walkway like a skylight rather than across the
   *      doorway, so on the way out you looked along it and its boundary
   *      crossed the view at chest height: "凭空出现了个横杆，挡着我面前";
   *    - its rake matched the closed ramp leaf's, so the two read as the same
   *      part at the same angle — "屏障和舱门关闭态倾斜角度反了…应该反一下";
   *    - its emitter rail needed a 3.8 m bar at (0, 2.28, 8.64), out at the
   *      far lip of the tunnel with the cabin nowhere near it.
   *
   *  In the doorway all three go away and the rail it is produced by is the
   *  door frame that was already there.  The field is a flat vertical sheet
   *  you step through at the threshold.
   */
  const barrier = new THREE.Mesh(
    new THREE.PlaneGeometry(SHIP.rampHalfW * 2 - 0.10, SHIP.rampTopY - 0.10, 1, 1),
    barrierMaterial(),
  );
  barrier.position.set(0, SHIP.rampTopY / 2, SHIP.holdEndZ - 0.07);
  barrier.renderOrder = 8;
  barrier.frustumCulled = false;
  group.add(barrier);

  /* The emitter frame.  A field with no visible source reads as a decal, so
     the door frame gets coil housings down both jambs and a sill across the
     threshold, all lit from inside — the field then looks like something
     this hardware is producing.  Everything is derived from rampHalfW and
     rampTopY, the same two numbers the plane uses. */
  {
    const hw = SHIP.rampHalfW, ty = SHIP.rampTopY;
    const z = SHIP.holdEndZ - 0.07;
    for (const sx of [-1, 1]) {
      /* jamb coil stack: a housing, coil rings, and a lit slot PER COIL.
         One continuous 2 m emissive strip down each jamb is a fluorescent
         tube, not an emitter — the same mistake as the flank window that
         became a 17 m light sabre.  Segmenting it into one short slot per
         coil is what makes it read as seven devices in a rack. */
      B.add('darkMetal', xf(bevelBox(0.16, ty - 0.04, 0.18, 0.02), mat(sx * (hw - 0.06), ty / 2, z)));
      B.add('blackMetal', xf(bevelBox(0.05, ty - 0.16, 0.10, 0.008), mat(sx * (hw - 0.145), ty / 2, z)));
      for (let i = 0; i < 7; i++) {
        const y = 0.18 + (i * (ty - 0.44)) / 6;
        B.add('brushed', xf(bevelBox(0.20, 0.05, 0.22, 0.012), mat(sx * (hw - 0.06), y, z)));
        B.add('strip', xf(bevelBox(0.020, 0.085, 0.045, 0.004), mat(sx * (hw - 0.158), y + 0.13, z)));
      }
      /* the cable run that feeds it, dropping into the deck */
      B.add('rubber', conduit([
        new THREE.Vector3(sx * (hw - 0.02), ty - 0.1, z - 0.12),
        new THREE.Vector3(sx * (hw + 0.05), 0.9, z - 0.14),
        new THREE.Vector3(sx * (hw + 0.02), 0.1, z - 0.10),
      ], 0.028, 7));
    }
    /* threshold sill: a raised plate with the emitter slot in its top face,
       so the field is seen to come OUT of the floor */
    B.add('darkMetal', xf(bevelBox(hw * 2 + 0.1, 0.10, 0.22, 0.02), mat(0, 0.05, z)));
    B.add('blackMetal', xf(bevelBox(hw * 2 - 0.2, 0.03, 0.08, 0.006), mat(0, 0.10, z)));
    B.add('glowCyan', xf(bevelBox(hw * 2 - 0.28, 0.012, 0.035, 0.004), mat(0, 0.112, z)));
    for (let i = -3; i <= 3; i++) {
      B.add('brushed', xf(new THREE.CylinderGeometry(0.03, 0.038, 0.055, 10), mat(i * 0.5, 0.075, z + 0.085)));
    }
    /* header: the lintel is structure, and it stays UNLIT.  A bright bar
       across the top of a doorway at head height is read as an obstruction
       however well it is modelled — that was the whole complaint. */
    B.add('darkMetal', xf(bevelBox(hw * 2 + 0.1, 0.11, 0.20, 0.02), mat(0, ty - 0.03, z)));
    B.add('blackMetal', xf(bevelBox(hw * 2 - 0.2, 0.035, 0.09, 0.006), mat(0, ty - 0.09, z)));
    /* status annunciators on the header, off to the sides of the walkway */
    for (const sx of [-1, 1]) {
      B.add('glowGreen', xf(new THREE.SphereGeometry(0.017, 8, 6), mat(sx * (hw - 0.42), ty - 0.10, z - 0.10)));
      B.add('hullAccent', xf(bevelBox(0.28, 0.008, 0.05, 0.004), mat(sx * (hw - 0.78), ty - 0.10, z - 0.11)));
    }
  }

  /* Interior lighting.
     These intensities are ~45% of the canvas-texture era.  The baked albedo
     is authored near white where the old procedural maps were mid-grey, so
     the same lamp returns roughly 2.4x the diffuse energy; without the cut
     the cabin reads as an overexposed studio instead of a lit interior. */
  const lights = [];
  const mkLight = (x, y, z, c, i, d) => {
    const l = new THREE.PointLight(c, i, d, 2);
    l.position.set(x, y, z);
    group.add(l);
    lights.push(l);
  };
  mkLight(0, 1.75, -8.5, 0x8fc2ff, 1.7, 6.5);
  mkLight(0, 2.15, -6.3, 0xaad0ff, 1.9, 7);
  mkLight(0, 1.86, -3.4, 0xbcd8ff, 1.9, 6.5);
  mkLight(0, 1.92, 1.2, 0xd8e6ff, 1.9, 7);
  mkLight(0, 1.92, 4.6, 0xd8e6ff, 1.8, 7);
  mkLight(0, 1.3, 6.7, 0x66aaff, 2.4, 5);

  /* ---- the two fixtures that actually cast ------------------------- *
     Point lights cannot cast cheaply — six cube faces each — so the shadows
     come from two SpotLights instead: one over the flight deck, one over the
     hold.  One shadow map apiece, aimed straight down, with a tight near/far
     so the depth range is spent on the cabin rather than on empty space.
     This is what puts the seat, the consoles and the crates ON the floor
     instead of merely near it. */
  const mkCaster = (x, y, z, c, i, d, ang) => {
    const l = new THREE.SpotLight(c, i, d, ang, 0.55, 2);
    l.position.set(x, y, z);
    l.target.position.set(x, 0, z);
    l.castShadow = true;
    l.shadow.mapSize.set(1024, 1024);
    l.shadow.camera.near = 0.3;
    l.shadow.camera.far = d;
    l.shadow.bias = -0.0009;
    l.shadow.normalBias = 0.022;
    group.add(l);
    group.add(l.target);
    return l;
  };
  mkCaster(0, 2.36, -7.30, 0xffe6c8, 2.8, 4.6, 0.95);
  mkCaster(0, 2.48, 2.60, 0xdfeaff, 3.2, 5.2, 1.02);

  B.flush(group, mats);
  return { group, barrier, lights, cockpit };
}

/* ------------------------------------------------------------------ *
 *  CONTAINMENT FIELD
 *
 *  The previous version was a faint hex grid plus a scan line at alpha
 *  0.28, and it read as a sheet of graph paper taped over the doorway.
 *  Four things are wrong with that and all four are fixed here:
 *
 *  1  NO VIEW DEPENDENCE.  A real field is a volume you look THROUGH, so it
 *     brightens at grazing incidence — the same reason a soap film shows its
 *     colours at the edges.  Without it the field looks equally thin from
 *     every angle, which is what makes it read as a decal.  vN/vV give a
 *     Fresnel-ish term here.
 *  2  ONE FREQUENCY.  A single hex lattice at one scale is a texture.  Two
 *     lattices at 3.2x with the fine one modulated by the coarse one reads
 *     as structure inside a volume.
 *  3  NO EVENT.  A static pattern is dead.  There is a travelling pulse up
 *     the rake, a slow lattice drift, and a per-cell flicker, so the field
 *     is never twice the same.
 *  4  NO BOUNDARY.  It bled to nothing at the frame.  A real field is
 *     BRIGHTEST where it meets its emitters, so the rim is a hard bright
 *     band that ties it to the rail geometry around the aperture.
 *
 *  Everything stays additive and clamped: an unbounded additive surface
 *  that the walk camera can straddle is exactly how the plume blacked out
 *  whole frames, and the clamp on vUv is the same guard for the same reason.
 * ------------------------------------------------------------------ */
function barrierMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpen: { value: 0 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vV;
      void main(){
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uOpen;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;

      /* signed distance to the nearest hex cell edge, in cell units */
      float hexEdge(vec2 p){
        p.x *= 1.1547;
        p.y += mod(floor(p.x), 2.0) * 0.5;
        vec2 f = fract(p) - 0.5;
        return 0.5 - max(abs(f.x) * 1.2, abs(f.y));
      }
      float hexId(vec2 p){
        p.x *= 1.1547;
        p.y += mod(floor(p.x), 2.0) * 0.5;
        vec2 i = floor(p);
        return fract(sin(i.x * 12.9898 + i.y * 78.233) * 43758.5453);
      }

      void main(){
        #include <logdepthbuf_fragment>
        /* clamp before use: the walk camera can straddle this plane at the
           ramp threshold, and a near-plane-crossing triangle interpolates
           varyings to +/-Inf, which bloom would smear over the whole frame.
           See the note on plumeMaterial() in ship/exterior.js. */
        vec2 uv = clamp(vUv, 0.0, 1.0);
        float t = mod(uTime, 64.0);

        /* two lattices, the fine one gated by the coarse one */
        vec2 pc = uv * vec2(5.0, 6.0) + vec2(0.0, t * 0.03);
        vec2 pf = uv * vec2(16.0, 19.0) - vec2(0.0, t * 0.11);
        float ec = smoothstep(0.10, 0.0, hexEdge(pc));
        float ef = smoothstep(0.06, 0.0, hexEdge(pf));
        float cellC = hexId(pc);
        float cellF = hexId(pf);
        /* per-cell flicker: a few cells are always brighter than the rest */
        float flick = 0.55 + 0.45 * sin(t * (1.7 + cellF * 3.1) + cellF * 31.0);
        float lattice = ec * 0.85 + ef * (0.30 + 0.45 * step(0.72, cellC)) * flick;

        /* a pulse travelling up the rake, plus the slow interference wash
           that keeps the interior of each cell from being flat */
        float pulse = exp(-pow((fract(uv.y - t * 0.22) - 0.5) / 0.10, 2.0));
        float wash = 0.5 + 0.5 * sin(uv.y * 22.0 + uv.x * 7.0 - t * 2.1);

        /* The boundary.  Now that the field stands IN the doorway its edges
           land on the jamb coils, the sill and the lintel, so a bright rim is
           reading as the hardware energising rather than as a bar hanging in
           the walkway — which is what it was when the sheet lay across the
           ramp at 45 degrees.  Kept modest all the same, and the vertical
           edges get more of it than the horizontal ones, so the eye is led
           down the jambs instead of across the path. */
        float bx = min(uv.x, 1.0 - uv.x);
        float by = min(uv.y, 1.0 - uv.y);
        float rim = smoothstep(0.085, 0.0, bx) * 0.85 + smoothstep(0.05, 0.0, by) * 0.4;
        float inner = smoothstep(0.0, 0.10, bx) * smoothstep(0.0, 0.06, by);

        /* Fresnel: a volume seen edge-on is thicker, so it brightens.
           Squared by multiplication — pow() on a possibly-negative base is
           undefined in GLSL and returns NaN, which is how the nebula grew
           pale shards (see environment.ts). */
        float f = 1.0 - clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
        float fres = 0.28 + 0.72 * (f * f);

        float a = (lattice * 0.20 + pulse * 0.30 + wash * 0.035 + 0.022) * inner * fres
                + rim * 0.20;
        a *= uOpen;

        /* hot cyan core toward the rim, deeper blue through the body, so the
           field has a temperature gradient rather than one flat hue */
        vec3 col = mix(vec3(0.20, 0.55, 1.0), vec3(0.62, 0.92, 1.0), clamp(rim + pulse * 0.7, 0.0, 1.0));
        gl_FragColor = clamp(vec4(col * a * 2.6, a * 0.9), 0.0, 32.0);
      }`,
  });
}
