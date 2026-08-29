// Exterior builder — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/exterior.ts
// (types stripped only; logic, constants and comments unchanged).
// Adaptation: the plume/halo ShaderMaterials carry logdepthbuf includes because
// this project's renderer runs with logarithmicDepthBuffer enabled.
import * as THREE from 'three';
import {
  buildLoft, mergeGeos, mirrorX, xf, mat, sectionAt, ringPoint,
  isSideEdge, isBellyEdge, isTopEdge, RING,
} from '../loft.js';
import { bevelBox, lathe, engineBell } from '../prims.js';
import { clipExteriorToCabin } from './clip.js';

/* ------------------------------------------------------------------ */
class Bucket {
  constructor() {
    this.m = new Map();
  }
  add(key, geo) {
    let a = this.m.get(key);
    if (!a) this.m.set(key, (a = []));
    a.push(geo);
  }
  addSym(key, geo) {
    this.add(key, geo);
    this.add(key, mirrorX(geo));
  }
  addParts(parts, m, sym = false) {
    for (const p of parts) {
      const g = xf(p.geo, m);
      if (sym) this.addSym(p.mat, g); else this.add(p.mat, g);
    }
  }
  flush(parent, mats, shadows = true) {
    for (const [k, list] of this.m) {
      const mesh = new THREE.Mesh(mergeGeos(list), mats[k]);
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.name = k;
      parent.add(mesh);
    }
    this.m.clear();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
function orient(pos, n, lift, spin = 0) {
  const up = n.clone().normalize();
  const q = new THREE.Quaternion();
  if (up.y < -0.9999) q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  else q.setFromUnitVectors(UP, up);
  if (spin) q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, spin));
  return new THREE.Matrix4().compose(pos.clone().addScaledVector(up, lift), q, new THREE.Vector3(1, 1, 1));
}

export function buildExterior(M, def) {
  const group = new THREE.Group();
  group.name = 'exterior';
  const B = new Bucket();
  const mats = M;
  const SHIP = def.dims;
  const { hull: HULL, nacelle: NACELLE, wing: WING, strake: STRAKE, fin: FIN, cant: CANT } = def;

  /* Placement helpers.  They live INSIDE the builder because every one of
     them queries this ship's section tables — as module-level closures over
     a single imported blueprint they were the reason the exterior could only
     ever build one hull. */
  const onTop = (z, x, lift = 0, spin = 0) =>
    orient(new THREE.Vector3(x, sectionAt(HULL, z).yTop, z), UP, lift, spin);
  const onBelly = (z, x, lift = 0, spin = 0) =>
    orient(new THREE.Vector3(x, sectionAt(HULL, z).yBot, z), DOWN, lift, spin);
  const onSide = (z, y, lift = 0, spin = 0) =>
    orient(new THREE.Vector3(sectionAt(HULL, z).w, y, z), new THREE.Vector3(1, 0, 0), lift, spin);
  function onSkin(z, ring, lift = 0, spin = 0) {
    const rp = ringPoint(sectionAt(HULL, z), ring, 'z', 0);
    return orient(rp.pos, rp.normal, lift, spin);
  }
  const nacTop = (z, dx, lift = 0, spin = 0) =>
    orient(new THREE.Vector3(SHIP.nacX + dx, sectionAt(NACELLE, z).yTop, z), UP, lift, spin);
  const nacBelly = (z, dx, lift = 0, spin = 0) =>
    orient(new THREE.Vector3(SHIP.nacX + dx, sectionAt(NACELLE, z).yBot, z), DOWN, lift, spin);
  function nacSide(z, y, outward, lift = 0, spin = 0) {
    const s = sectionAt(NACELLE, z);
    return orient(
      new THREE.Vector3(SHIP.nacX + (outward ? s.w : -s.w), y, z),
      new THREE.Vector3(outward ? 1 : -1, 0, 0), lift, spin,
    );
  }

  const canopySpan = (a, b) => a >= SHIP.canopyFront - 1e-4 && b <= SHIP.canopyRear + 1e-4;
  const rampSpan = (a, b) => a >= SHIP.rampHingeZ - 1e-4 && b <= SHIP.rampTopZ + 1e-4;


  /* ============ PRIMARY HULL SHELL ============ */
  B.add('hull', buildLoft(HULL, { edge: isSideEdge, uvScale: 2.4 }));
  B.add('hull', buildLoft(HULL, { edge: isTopEdge, span: (a, b) => !canopySpan(a, b), uvScale: 2.4 }));
  B.add('hull', buildLoft(HULL, { edge: isBellyEdge, span: (a, b) => !rampSpan(a, b), uvScale: 2.4 }));
  B.add('hullDark', buildLoft(HULL, { edge: () => true, span: () => false, capStart: true }));
  B.add('hullDark', buildLoft(HULL, { edge: () => true, span: () => false, capEnd: true }));

  /* conformal livery — derived from the very same surface, so it can
     never float, gap or z-fight.  The bands are per ship: they are paint,
     and paint is where a hull gets its identity. */
  for (const st of def.livery) {
    const set = new Set();
    for (const e of st.edges) { set.add(e); set.add(RING - 1 - e); }
    B.add(st.key, buildLoft(HULL, {
      edge: (e) => set.has(e), span: (a, b) => a >= st.z0 - 1e-4 && b <= st.z1 + 1e-4,
      offset: st.off ?? 0.014, uvScale: 1.2,
    }));
  }
  /* the ramp's outer accent, on the belly band.  Its start is derived from
     the ramp itself (the outer third) rather than written down, so it stays
     on the ramp when a hull has a different one. */
  const rampAccentZ0 = SHIP.rampHingeZ + (SHIP.rampTopZ - SHIP.rampHingeZ) * 0.67;
  B.add('hullAccent', buildLoft(HULL, {
    edge: isBellyEdge, span: (a, b) => a >= rampAccentZ0 && b <= SHIP.rampTopZ + 1e-4,
    offset: 0.014, uvScale: 0.5,
  }));

  /* ============ CANOPY ============
     The canopy is built by the cockpit module now (ship/cockpit/frame.js).
     It is ONE surface seen from both sides, so glazing panes, external
     retaining strips and internal trim caps all derive from a single pane
     layout in ship/cockpit/datum.js — which is also what fixed the old
     problem of the exterior rails and the interior frames disagreeing
     about where the glass edge was.  The solid roof over the pilot's head
     is added there too, in the part of the top band this shell skips. */

  /* ============ APPENDAGES ============
     Each is optional: a hull with no wing omits the table rather than
     lofting a zero-length one, which would emit a degenerate strip and
     then a NaN normal.  `has` defaults to true for backwards
     compatibility with the reference def. */
  const has = (k, table) =>
    (def.has?.[k] ?? true) && table.length > 1;

  if (has('wing', WING)) {
    B.addSym('hull', buildLoft(WING, { axis: 'x', capEnd: true, uvScale: 2.2 }));
    /* leading-edge armour: ring indices 33-38 are the forward face of the aerofoil */
    B.addSym('hullDark', buildLoft(WING, {
      axis: 'x', offset: 0.018, uvScale: 1.2,
      edge: (e) => e >= 33 && e <= 38,
    }));
    const root = WING[0].at, tip = WING[WING.length - 1].at;
    B.addSym('hullAccent', buildLoft(WING, {
      axis: 'x', offset: 0.016, uvScale: 1.0,
      /* the outboard half of the span, so the flash reads as a marking
         rather than as a full-length rib */
      span: (a, b) => a >= root + (tip - root) * 0.49 && b <= root + (tip - root) * 0.85,
      edge: (e) => e >= 10 && e <= 13,
    }));
  }

  if (has('strake', STRAKE)) {
    B.addSym('hull', buildLoft(STRAKE, { axis: 'x', capEnd: true, uvScale: 1.8 }));
    B.addSym('hullDark', buildLoft(STRAKE, {
      axis: 'x', offset: 0.014, uvScale: 1.0, edge: (e) => e >= 33 && e <= 38,
    }));
  }

  /* ============ NACELLES ============ */
  if (NACELLE.length > 1) {
    const n0 = NACELLE[0].at, n1 = NACELLE[NACELLE.length - 1].at;
    const span = (t0, t1) => (a, b) =>
      a >= n0 + (n1 - n0) * t0 && b <= n0 + (n1 - n0) * t1;
    B.addSym('hull', buildLoft(NACELLE, { capEnd: true, uvScale: 2.2 }));
    B.addSym('hullDark', buildLoft(NACELLE, {
      offset: 0.014, uvScale: 1.1,
      edge: (e) => e === 11 || e === 12 || e === RING - 12 || e === RING - 13,
      span: span(0.21, 0.92),
    }));
    B.addSym('hullAccent', buildLoft(NACELLE, {
      offset: 0.016, uvScale: 0.9,
      edge: (e) => e === 1 || e === 2 || e === RING - 2 || e === RING - 3,
      span: span(0.34, 0.83),
    }));
  }
  if (has('cant', CANT)) {
    const cr = def.cantRoot ?? {};
    const place = new THREE.Matrix4().makeTranslation(cr.x ?? SHIP.nacX, cr.y ?? 0.55, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(cr.tilt ?? -0.36));
    B.addSym('hull', xf(buildLoft(CANT, { axis: 'y', capEnd: true, uvScale: 1.8 }), place));
    B.addSym('hullAccent', xf(buildLoft(CANT, {
      axis: 'y', offset: 0.015, uvScale: 0.9, edge: (e) => e >= 9 && e <= 12,
    }), place));
  }

  /* ============ DORSAL FIN ============ */
  if (has('fin', FIN)) {
    B.add('hull', buildLoft(FIN, { axis: 'y', capEnd: true, uvScale: 2.0 }));
    B.add('hullDark', buildLoft(FIN, { axis: 'y', offset: 0.014, uvScale: 1.0, edge: (e) => e >= 9 && e <= 13 }));
  }

  /* ============ ENGINES ============ */
  /** blinking lamps: the core makes none, the dressing hook fills this */
  const strobes = [];
  const plumes = [];
  const glowRings = [];
  const mkEngine = (x, y, z, R) => {
    B.addParts(engineBell(R).parts, mat(x, y, z, Math.PI / 2, 0, 0));
    B.add('darkMetal', xf(lathe([[R * 1.02, -0.1], [R * 1.16, -0.04], [R * 1.16, 0.12], [R * 1.0, 0.16]], 30), mat(x, y, z - 0.42, Math.PI / 2, 0, 0)));
  };
  for (const e of def.engines) mkEngine(e.x, e.y, e.z, e.r);

  /* The four engines share two instanced draw calls: one integrated potential
     core / turbulent shear volume and the thin hot throat.  Their transforms
     are authored from the SAME engine table as the physical bells, so the
     exhaust origin cannot drift away from a nozzle when the hull changes.

     Geometry begins 0.06R inside the rolled lip (the bell lip is +0.40R), at
     the 0.22R throat rather than across the whole aperture.  Throttle is a
     vertex-shader axial stretch from that fixed root; it never scales or
     translates the root radius. */
  const plumeRoot = (engine) => new THREE.Vector3(
    engine.x, engine.y, engine.z + engine.r * 0.34);
  const plumeRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const instanceMatrix = new THREE.Matrix4();
  const instanceScale = new THREE.Vector3();
  const addInstances = (geometry, material, name, order, atLip = false) => {
    const mesh = new THREE.InstancedMesh(geometry, material, def.engines.length);
    mesh.name = name;
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    def.engines.forEach((engine, index) => {
      const root = atLip
        ? new THREE.Vector3(engine.x, engine.y, engine.z + engine.r * 0.405)
        : plumeRoot(engine);
      const rotation = atLip ? new THREE.Quaternion() : plumeRotation;
      instanceScale.setScalar(engine.r);
      instanceMatrix.compose(root, rotation, instanceScale);
      mesh.setMatrixAt(index, instanceMatrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.nozzleRoots = def.engines.map((engine) => plumeRoot(engine).toArray());
    mesh.userData.engineRadii = def.engines.map((engine) => engine.r);
    group.add(mesh);
    return mesh;
  };
  const plume = addInstances(
    plumeGeometry(), plumeMaterial(), 'engine-plume-volume', 3);
  plumes.push(plume);
  const lipGlow = addInstances(
    new THREE.CircleGeometry(1.07, 40), haloMaterial(), 'engine-plume-lip', 5, true);
  glowRings.push(lipGlow);

  /* ============ SHIP-SPECIFIC DRESSING ============ *
     Runs before the ramp so the ramp's own bucket flush is last, and takes
     the same placement helpers the core uses — see DressCtx in def.js. */
  def.dressExterior?.({
    B, M, group, strobes,
    dims: SHIP, hull: HULL, nacelle: NACELLE, wing: WING,
    strake: STRAKE, fin: FIN, cant: CANT,
    onTop, onBelly, onSide, onSkin, nacTop, nacBelly, nacSide,
  });

  /* ============ CARGO RAMP (hinged) ============ */
  const rampPivot = new THREE.Group();
  rampPivot.position.set(0, SHIP.rampHingeY, SHIP.rampHingeZ);
  group.add(rampPivot);
  {
    const toPivot = mat(0, -SHIP.rampHingeY, -SHIP.rampHingeZ);
    const RB = new Bucket();
    RB.add('hull', xf(buildLoft(HULL, { edge: isBellyEdge, span: rampSpan, uvScale: 2.4 }), toPivot));
    RB.add('hullAccent', xf(buildLoft(HULL, {
      edge: isBellyEdge, span: (a, b) => a >= 7.85 && b <= SHIP.rampTopZ + 1e-4, offset: 0.015, uvScale: 0.5,
    }), toPivot));
    RB.add('deck', xf(buildLoft(HULL, {
      edge: isBellyEdge, span: rampSpan, offset: -0.17, flipWinding: false, uvScale: 1.3,
    }), toPivot));
    const L = Math.SQRT2 * (SHIP.rampTopZ - SHIP.rampHingeZ);
    const along = (t, lift) =>
      mat(0, lift * Math.SQRT1_2 + t * Math.SQRT1_2, -lift * Math.SQRT1_2 + t * Math.SQRT1_2, -Math.PI / 4);
    for (const sx of [-1, 1]) {
      const m = along(L / 2, 0.1);
      m.setPosition(sx * (SHIP.rampHalfW - 0.05), m.elements[13], m.elements[14]);
      RB.add('trim', xf(bevelBox(0.1, 0.22, L, 0.03), m));
    }
    RB.add('trim', xf(bevelBox(SHIP.rampHalfW * 2, 0.2, 0.15, 0.03), along(L - 0.075, 0.09)));
    // hinge-end closure so the ramp reads as a solid slab from every angle
    RB.add('trim', xf(bevelBox(SHIP.rampHalfW * 2, 0.2, 0.13, 0.03), along(0.065, 0.09)));
    for (const sx of [-1, 1]) {
      RB.add('brushed', xf(new THREE.CylinderGeometry(0.1, 0.1, 0.32, 12).rotateZ(Math.PI / 2), mat(sx * 1.45, 0, 0.02)));
      RB.add('darkMetal', xf(bevelBox(0.2, 0.3, 0.28, 0.04), mat(sx * 1.45, 0.06, 0.14)));
    }
    for (let i = 1; i < 10; i++) {
      RB.add('blackMetal', xf(bevelBox(SHIP.rampHalfW * 1.75, 0.03, 0.085, 0.01), along((i / 10) * L, 0.19)));
    }
    for (const sx of [-1, 1]) {
      const m = along(0.85, 0.3);
      m.setPosition(sx * 1.55, m.elements[13], m.elements[14]);
      RB.add('brushed', xf(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 10).rotateX(Math.PI / 2), m));
    }
    RB.flush(rampPivot, mats);
  }

  /* ---- ramp tunnel: triangular side walls + flat soffit ---- */
  {
    const L = SHIP.rampTopZ - SHIP.rampHingeZ;
    const TB = new Bucket();
    for (const sx of [-1, 1]) {
      const g = new THREE.BufferGeometry();
      const tri = [
        new THREE.Vector3(sx * SHIP.rampHalfW, SHIP.rampHingeY, SHIP.rampHingeZ),
        new THREE.Vector3(sx * SHIP.rampHalfW, SHIP.rampTopY, SHIP.rampTopZ),
        new THREE.Vector3(sx * SHIP.rampHalfW, SHIP.rampTopY, SHIP.rampHingeZ),
      ];
      /* Wind the triangle so its face normal matches the normal attribute.
         With A at the hinge, B at the ramp top and C above the hinge, the
         cross product (B-A)x(C-A) points at -x, which is INBOARD on the
         starboard wall and outboard on the port one — so only the port
         triangle is reversed.  It was the other way round, which left both
         walls with their winding disagreeing with the normals they had been
         handed: they rendered (M.liner is DoubleSide) but shaded as if lit
         from outside the tunnel.  tools/holes.mjs counted 18 rays hitting
         this surface from behind. */
      if (sx < 0) tri.reverse();
      g.setAttribute('position', new THREE.Float32BufferAttribute(tri.flatMap((v) => [v.x, v.y, v.z]), 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1], 2));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([-sx, 0, 0, -sx, 0, 0, -sx, 0, 0], 3));
      TB.add('liner', g);
      /* The rubbing batten on the tunnel wall, running up the aperture's own
         diagonal.  Its rake was -PI/4 — the opposite diagonal — so instead of
         lying along the wall's hypotenuse it cut ACROSS the doorway, and from
         inside the hold the two of them drew a bright X over the containment
         field.  That is the second half of the reversed-angle report; the
         field itself was the first (see interior.js).  Centre and length are
         derived from the two aperture corners rather than written down. */
      const dY = SHIP.rampTopY - SHIP.rampHingeY;
      const dZ = SHIP.rampTopZ - SHIP.rampHingeZ;
      TB.add('trim', xf(bevelBox(0.085, 0.18, Math.hypot(dY, dZ) - 0.06, 0.02),
        mat(sx * (SHIP.rampHalfW - 0.04),
          SHIP.rampHingeY + dY / 2,
          SHIP.rampHingeZ + dZ / 2,
          Math.atan2(dY, dZ))));
    }
    TB.add('liner', xf(new THREE.PlaneGeometry(SHIP.rampHalfW * 2, L).rotateX(Math.PI / 2),
      mat(0, SHIP.rampTopY, SHIP.rampHingeZ + L / 2)));
    TB.flush(group, mats, false);
  }

  B.flush(group, mats);
  /* Nothing of the exterior may stand inside the cabin.  See clip.js: this
     is what removes the pale sheet that ran along both flight-deck walls and
     through the aft bulkhead (the strake's root), and the engine pods'
     inboard flanks from the cargo hold.  Gate: tools/intrude.mjs. */
  clipExteriorToCabin(group, def);
  return { group, rampPivot, plumes, glowRings, strobes };
}

/* ---- engine plume / halo shaders ------------------------------------------
 *
 * This is a textureless analytic emissive volume, not a fire image pasted onto
 * cones.  A camera-facing density integral gives every side view one continuous
 * soft cross-section instead of exposing intersecting transparency planes.
 * A compact throat volume preserves axial/chase readability.
 * The short potential core is integrated into the same density field as the
 * entrained shear, so small manoeuvring jets cannot leave detached bright
 * fragments when the hull occludes their roots.  The layer stays coherent,
 * progressively filamentary, then dissipating before the geometric tip.
 *
 * Premultiplied normal blending is deliberate.  Additive blue shells made
 * every overlap brighter than the source and polluted bloom across the hull;
 * the new outer layer stays below the bloom knee while only compact core cells
 * carry HDR radiance.  The camera-to-axis guard retains the old near-plane
 * safety without making a normal stern view disappear.
 */
function plumeGeometry() {
  const segments = 34;
  const length = 7.6;
  const profileRadius = (t) => {
    const shearExpansion = 0.45 + 0.64 * (1 - Math.exp(-t * 7));
    const dissolution = 1 - t * 0.48;
    const breathing = 1 + Math.sin(Math.pow(t, 0.9) * Math.PI * 5.5)
      * 0.04 * (1 - t);
    return shearExpansion * dissolution * breathing;
  };
  const positions = [];
  const normals = [];
  const uvs = [];
  const addVertex = (point, normal, uv) => {
    positions.push(point.x, point.y, point.z);
    normals.push(normal.x, normal.y, normal.z);
    uvs.push(uv[0], uv[1]);
  };
  const addTriangle = (a, b, c, normal, uvA, uvB, uvC) => {
    addVertex(a, normal, uvA);
    addVertex(b, normal, uvB);
    addVertex(c, normal, uvC);
  };
  /* The shader rotates this single density ribbon around the plume axis to
     face the camera.  The authored radius stays broad at the far end: opacity
     dissipates statistically before the mesh ends, so no geometric needle or
     triangular point can become visible against a dark sky. */
  const normal = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const r0 = profileRadius(t0);
    const r1 = profileRadius(t1);
    const left0 = new THREE.Vector3(-r0, t0 * length, 0);
    const right0 = new THREE.Vector3(r0, t0 * length, 0);
    const left1 = new THREE.Vector3(-r1, t1 * length, 0);
    const right1 = new THREE.Vector3(r1, t1 * length, 0);
    addTriangle(left0, right0, right1, normal,
      [0, t0], [1, t0], [1, t1]);
    addTriangle(left0, right1, left1, normal,
      [0, t0], [1, t1], [0, t1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.name = 'integrated engine plume volume';
  return geometry;
}

function plumeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPower: { value: 0.1 },
    },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: true,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uTime; uniform float uPower;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      varying vec3 vRootWorld; varying vec3 vAxisWorld;
      varying float vEngineRadius; varying float vLengthScale;
      void main(){
        vUv = clamp(uv, 0.0, 1.0);
        float drive = smoothstep(0.06, 1.7, uPower);
        float response = pow(drive, 0.72);
        float lengthScale = mix(0.38, 1.14, response);
        vec3 localPosition = position;
        localPosition.y *= lengthScale;

        /* The spent shear wanders by at most 5.5% of one nozzle radius.  The
           t² term mathematically locks the integrated core to the throat. */
        float t = vUv.y;
        localPosition.x += sin(uTime * 2.0 + t * 7.0)
          * (0.055 * t * t * (1.0 - drive * 0.35));

        mat4 instance = mat4(1.0);
        #ifdef USE_INSTANCING
          instance = instanceMatrix;
        #endif
        vec3 rootWorld = (modelMatrix * instance
          * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 axisWorld = normalize((modelMatrix * instance
          * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        float engineRadius = length((modelMatrix * instance
          * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
        vec3 cameraRay = cameraPosition - rootWorld;
        vec3 widthCandidate = cross(axisWorld, cameraRay);
        vec3 fallback = abs(axisWorld.y) < 0.94
          ? cross(axisWorld, vec3(0.0, 1.0, 0.0))
          : cross(axisWorld, vec3(1.0, 0.0, 0.0));
        float hasWidth = step(1e-7, dot(widthCandidate, widthCandidate));
        vec3 widthWorld = normalize(mix(fallback, widthCandidate, hasWidth));
        vec3 worldPosition = rootWorld
          + widthWorld * localPosition.x * engineRadius
          + axisWorld * localPosition.y * engineRadius;
        vec4 wp = vec4(worldPosition, 1.0);
        vN = normalize(cross(widthWorld, axisWorld));
        vV = normalize(cameraPosition - wp.xyz);
        vRootWorld = rootWorld;
        vAxisWorld = axisWorld;
        vEngineRadius = engineRadius;
        vLengthScale = lengthScale;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uPower;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      varying vec3 vRootWorld; varying vec3 vAxisWorld;
      varying float vEngineRadius; varying float vLengthScale;

      float transportedTurbulence(vec2 p, float phase) {
        /* Three advected, incommensurate waves give a continuous shear field
           without a texture fetch or discontinuous cell hash.  Integer phase
           multipliers make the CPU's 2π wrap exactly periodic. */
        float a = sin(p.x * 1.13 + p.y * 0.83 - phase * 3.0);
        float b = sin(p.x * 2.41 - p.y * 0.71 + sin(p.x * 0.53) - phase * 5.0);
        float c = cos(p.x * 4.07 + p.y * 1.29 - phase * 7.0);
        return clamp(0.53 + a * 0.24 + b * 0.15 + c * 0.08, 0.0, 1.0);
      }
      void main(){
        #include <logdepthbuf_fragment>
        vec2 uv = clamp(vUv, 0.0, 1.0);
        float t = uv.y;
        float drive = smoothstep(0.06, 1.7, uPower);
        float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.045, 1.0);
        float radialCoordinate = abs(uv.x * 2.0 - 1.0);
        float radialDensity = 1.0 - smoothstep(0.18, 1.0, radialCoordinate);

        /* Distance to the finite plume axis.  If a chase transition crosses
           it, fade before a near-plane triangle can feed non-finite energy to
           bloom.  Outside the actual segment the endpoint distance restores
           full opacity, so a normal stern composition remains intact. */
        float baseLength = 7.6 * vEngineRadius * vLengthScale;
        vec3 cameraFromRoot = cameraPosition - vRootWorld;
        float cameraAlong = clamp(dot(cameraFromRoot, vAxisWorld), 0.0, baseLength);
        float cameraAxisDistance = length(cameraFromRoot - vAxisWorld * cameraAlong);
        float cameraFade = smoothstep(vEngineRadius * 0.42,
          vEngineRadius * 1.85, cameraAxisDistance);

        vec2 flowUv = vec2(uv.x * 11.0 + t * 2.7, t * 15.0);
        float turbulence = transportedTurbulence(flowUv, uTime);

        /* One continuous density integral: a narrow potential core lives
           inside the root of the broad shear layer.  It has no independent
           transparent surface that could survive hull occlusion as a floating
           rectangle. */
        float rootAttach = smoothstep(0.0,
          0.12 + radialCoordinate * 0.18, t);
        float coreAttach = smoothstep(0.0,
          0.035 + radialCoordinate * 0.05, t);
        float spent = 1.0 - smoothstep(0.50, 0.96, t);
        float filament = mix(0.88, 0.18 + turbulence * 0.95,
          smoothstep(0.12, 0.78, t));
        float breakup = mix(1.0, smoothstep(0.28, 0.76, turbulence),
          smoothstep(0.48, 0.94, t));
        float cellBreath = 0.82 + 0.18 * cos(pow(t, 0.9) * 17.278);
        float coreDensity = 1.0 - smoothstep(0.06, 0.40, radialCoordinate);
        float coreEnergy = exp(-t * 3.8) * coreDensity * coreAttach;
        float opticalDepth = (0.17 + drive * 0.20) * rootAttach * spent
          * filament * breakup * cellBreath * radialDensity;
        opticalDepth += (0.16 + drive * 0.21) * coreEnergy;
        opticalDepth *= cameraFade;
        float viewGain = mix(0.82, 1.08, 1.0 - ndv);
        float alpha = clamp(1.0 - exp(-opticalDepth * 0.46 * viewGain), 0.0, 0.26);
        vec3 coldShear = mix(vec3(0.62, 0.82, 1.0), vec3(0.10, 0.26, 0.68),
          smoothstep(0.10, 0.92, t));
        vec3 color = mix(coldShear, vec3(1.0, 0.94, 0.80),
          smoothstep(0.02, 0.48, coreEnergy));
        float radiance = mix(1.10, 0.36, smoothstep(0.08, 0.96, t))
          * (0.82 + drive * 0.18)
          + coreEnergy * (1.30 + drive * 0.90);
        gl_FragColor = clamp(vec4(color * radiance * alpha, alpha), 0.0, 2.8);
        if (gl_FragColor.a < 0.002) discard;
      }`,
  });
}
function haloMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uPower: { value: 0.1 } },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: true,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vRadius; varying vec3 vWorld;
      void main(){
        mat4 instance = mat4(1.0);
        #ifdef USE_INSTANCING
          instance = instanceMatrix;
        #endif
        vec4 wp = modelMatrix * instance * vec4(position, 1.0);
        vRadius = length(position.xy);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uPower; varying float vRadius; varying vec3 vWorld;
      void main(){
        #include <logdepthbuf_fragment>
        float drive = smoothstep(0.06, 1.7, uPower);
        float lip = exp(-pow((vRadius - 0.73) / 0.105, 2.0));
        float throat = exp(-pow(vRadius / 0.48, 2.2));
        float cameraFade = smoothstep(0.35, 1.35, distance(cameraPosition, vWorld));
        float lipAlpha = (0.065 + drive * 0.085) * lip;
        float throatAlpha = (0.055 + drive * 0.115) * throat;
        float baseAlpha = lipAlpha + throatAlpha;
        float alpha = baseAlpha * cameraFade;
        vec3 lipColor = mix(vec3(1.0, 0.91, 0.72), vec3(0.42, 0.72, 1.0),
          smoothstep(0.56, 0.94, vRadius));
        vec3 throatColor = mix(vec3(1.0, 0.95, 0.83), vec3(0.54, 0.78, 1.0),
          smoothstep(0.0, 0.72, vRadius));
        vec3 color = (lipColor * lipAlpha + throatColor * throatAlpha)
          / max(baseAlpha, 0.001);
        float radiance = 1.20 + drive * 0.92;
        gl_FragColor = clamp(vec4(color * radiance * alpha, alpha), 0.0, 2.2);
        if (alpha < 0.002) discard;
      }`,
  });
}
