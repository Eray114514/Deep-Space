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
     core / turbulent shear volume and the recessed hot throat.  Their transforms
     are authored from the SAME engine table as the physical bells, so the
     exhaust origin cannot drift away from a nozzle when the hull changes.

     Geometry begins 0.01R inside the rolled lip (the bell lip is +0.40R), at
     the 0.22R throat rather than across the whole aperture.  Throttle is a
     vertex-shader axial stretch from that fixed root; it never scales or
     translates the root radius. */
  const plumeRoot = (engine) => new THREE.Vector3(
    engine.x, engine.y, engine.z + engine.r * 0.39);
  const plumeRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const instanceMatrix = new THREE.Matrix4();
  const instanceScale = new THREE.Vector3();
  const addInstances = (geometry, material, name, order, inThroat = false) => {
    const mesh = new THREE.InstancedMesh(geometry, material, def.engines.length);
    mesh.name = name;
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    def.engines.forEach((engine, index) => {
      const root = inThroat
        ? new THREE.Vector3(engine.x, engine.y, engine.z + engine.r * 0.425)
        : plumeRoot(engine);
      const rotation = inThroat ? new THREE.Quaternion() : plumeRotation;
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
    nozzleGlowGeometry(), haloMaterial(), 'engine-plume-throat', 5, true);
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
 * This is a textureless analytic emissive VOLUME, not a camera-facing card.
 * A small box only supplies the raster footprint; every fragment intersects
 * that box in engine-local space and integrates a round density field along
 * the actual camera ray.  Axial and oblique views therefore see the same 3D
 * plume, with no plane edge for the nozzle or depth buffer to cut in half.
 *
 * Premultiplied normal blending is deliberate.  Additive blue shells made
 * every overlap brighter than the source and polluted bloom across the hull;
 * the shear stays below the bloom knee while only the compact potential core
  * carries restrained HDR radiance.  Back faces supply exactly one exit surface
  * whether the camera is outside or inside the proxy box; the analytic box hit
  * then clamps an internal camera's entry to zero.  Close chase cameras therefore
  * keep the exhaust instead of losing the whole volume to front-face culling.
 */
function plumeGeometry() {
  const geometry = new THREE.BoxGeometry(2.32, 7.6, 2.32, 1, 1, 1);
  geometry.translate(0, 3.8, 0);
  geometry.name = 'engine plume raymarch bounds';
  return geometry;
}

function nozzleGlowGeometry() {
  const angularSegments = 48;
  const radialSegments = 8;
  const radius = 0.88;
  const positions = [0, 0, -0.30];
  const uvs = [0.5, 0.5];
  const indices = [];
  for (let radial = 1; radial <= radialSegments; radial++) {
    const t = radial / radialSegments;
    const ringRadius = radius * t;
    /* This is a real recessed dish, not a centre vertex pulled out of a flat
       triangle fan.  Eight radial rings give the throat a readable 0.30R bowl
       and let the physical bell ribs occlude the gas from oblique views. */
    const ridgeOffset = (t - 0.80) / 0.12;
    const annularRidge = 0.12 * Math.exp(-(ridgeOffset * ridgeOffset));
    const z = -0.30 * (1.0 - t * t) + annularRidge;
    for (let angular = 0; angular < angularSegments; angular++) {
      const a = angular / angularSegments * Math.PI * 2;
      positions.push(Math.cos(a) * ringRadius, Math.sin(a) * ringRadius, z);
      uvs.push(0.5 + Math.cos(a) * t * 0.5, 0.5 + Math.sin(a) * t * 0.5);
    }
  }
  for (let angular = 0; angular < angularSegments; angular++) {
    indices.push(0, 1 + angular, 1 + (angular + 1) % angularSegments);
  }
  for (let radial = 1; radial < radialSegments; radial++) {
    const inner = 1 + (radial - 1) * angularSegments;
    const outer = 1 + radial * angularSegments;
    for (let angular = 0; angular < angularSegments; angular++) {
      const next = (angular + 1) % angularSegments;
      indices.push(inner + angular, outer + angular, outer + next);
      indices.push(inner + angular, outer + next, inner + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = 'engine nozzle recessed hot throat';
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
    side: THREE.BackSide,
    toneMapped: true,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uTime; uniform float uPower;
      varying vec3 vLocalSurface; varying vec3 vCameraLocal;
      varying float vLengthScale;
      void main(){
        float drive = smoothstep(0.06, 1.7, uPower);
        float response = pow(drive, 0.72);
        float lengthScale = mix(0.38, 1.14, response);
        mat4 instance = mat4(1.0);
        #ifdef USE_INSTANCING
          instance = instanceMatrix;
        #endif
        /* Small manoeuvring bells need enough physical reach to remain legible
           beside the main nacelles, but keep the same radius and temperature. */
        float authoredRadius = length(instance[0].xyz);
        lengthScale *= mix(1.28, 1.0, smoothstep(0.34, 0.92, authoredRadius));
        vec3 localPosition = position;
        localPosition.y *= lengthScale;
        vec3 rootWorld = (modelMatrix * instance
          * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 basisX = (modelMatrix * instance
          * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
        vec3 basisY = (modelMatrix * instance
          * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        vec3 basisZ = (modelMatrix * instance
          * vec4(0.0, 0.0, 1.0, 0.0)).xyz;
        float engineRadius = max(length(basisX), 0.0001);
        basisX /= engineRadius;
        basisY = normalize(basisY);
        basisZ = normalize(basisZ);
        vec3 cameraDelta = cameraPosition - rootWorld;
        vCameraLocal = vec3(dot(cameraDelta, basisX),
          dot(cameraDelta, basisY), dot(cameraDelta, basisZ)) / engineRadius;
        vLocalSurface = localPosition;
        vLengthScale = lengthScale;
        vec4 wp = modelMatrix * instance * vec4(localPosition, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uPower;
      varying vec3 vLocalSurface; varying vec3 vCameraLocal;
      varying float vLengthScale;

      float transportedTurbulence(vec3 p, float phase) {
        /* Three travelling pressure waves form an inexpensive three-dimensional
           flow field.  None is camera-aligned, so their intersections survive
           the ray integral as rolling shear folds instead of horizontal bands. */
        float a = sin(dot(p, vec3(1.83, 2.31, -1.27)) - phase * 3.0);
        float b = sin(dot(p, vec3(-2.71, 4.17, 2.13)) - phase * 5.0
          + a * 0.72);
        float c = cos(dot(p, vec3(3.67, 5.43, 2.89)) - phase * 7.0
          + b * 0.44);
        return clamp(0.52 + a * 0.24 + b * 0.16 + c * 0.08,
          0.0, 1.0);
      }
      void main(){
        #include <logdepthbuf_fragment>
        float drive = smoothstep(0.06, 1.7, uPower);
        vec3 rayVector = vLocalSurface - vCameraLocal;
        float rayVectorLength = length(rayVector);
        if (rayVectorLength < 0.0001) discard;
        vec3 rayDirection = rayVector / rayVectorLength;
        vec3 raySign = mix(vec3(1.0), sign(rayDirection),
          greaterThan(abs(rayDirection), vec3(0.0001)));
        vec3 inverseRay = raySign / max(abs(rayDirection), vec3(0.0001));
        vec3 boxMin = vec3(-1.16, 0.0, -1.16);
        vec3 boxMax = vec3(1.16, 7.6 * vLengthScale, 1.16);
        vec3 hitA = (boxMin - vCameraLocal) * inverseRay;
        vec3 hitB = (boxMax - vCameraLocal) * inverseRay;
        vec3 nearHit = min(hitA, hitB);
        vec3 farHit = max(hitA, hitB);
        float rayEnter = max(max(nearHit.x, nearHit.y), max(nearHit.z, 0.0));
        float rayExit = min(min(farHit.x, farHit.y), farHit.z);
        if (rayExit <= rayEnter) discard;

        const int MARCH_STEPS = 16;
        float segmentLength = rayExit - rayEnter;
        float stepLength = segmentLength / float(MARCH_STEPS);
        vec3 accumulatedColor = vec3(0.0);
        float accumulatedAlpha = 0.0;
        for (int index = 0; index < MARCH_STEPS; index++) {
          float distanceAlong = rayEnter + (float(index) + 0.5) * stepLength;
          vec3 samplePosition = vCameraLocal + rayDirection * distanceAlong;
          float t = clamp(samplePosition.y / max(7.6 * vLengthScale, 0.001), 0.0, 1.0);
          /* Four coupled compression cells remain below the 16-step Nyquist
             limit and survive both axial and oblique integration. */
          float cell = 0.5 + 0.5 * cos(t * 25.13 - 0.45);
          float compression = cell * cell;
          float expansion = (0.40 + drive * 0.045)
            + (0.55 + drive * 0.045) * (t / (t + 0.105));
          float envelope = expansion * (1.0 - t * 0.12)
            * (0.955 + compression * 0.095 * (1.0 - t));

          /* A tiny downstream wander and cross-flow warp break the mathematically
             perfect cone while the t^1.45 term keeps the first nozzle diameter
             rigidly centred.  This is density motion, not mesh deformation. */
          float wanderGain = 0.115 * t * sqrt(max(t, 0.0))
            * (1.0 - drive * 0.22);
          vec2 wander = vec2(
            sin(samplePosition.y * 1.37 - uTime * 3.0
              + sin(samplePosition.z * 1.9)),
            cos(samplePosition.y * 1.11 - uTime * 5.0
              + sin(samplePosition.x * 1.6))) * wanderGain;
          vec2 flowCross = samplePosition.xz - wander;
          float rawRadial = length(flowCross) / max(envelope, 0.08);
          float turbulence = transportedTurbulence(
            vec3(flowCross.x, samplePosition.y, flowCross.y), uTime);
          float edgeWarp = (turbulence - 0.5) * 0.34
            * smoothstep(0.10, 0.86, t);
          float radial = max(0.0, rawRadial - edgeWarp);

          /* The plume is two coupled volumes: a hollow, rolling mixing layer and
             a compact potential core.  Ray integration through the shell gives
             genuine limb depth; there is no screen-facing opacity gradient. */
          float interiorBase = max(0.0, 1.0 - smoothstep(0.08, 0.98, radial));
          float interior = interiorBase * interiorBase;
          float shellCentre = 0.72 + (turbulence - 0.5) * 0.105;
          float shell = (1.0 - smoothstep(0.055, 0.27, abs(radial - shellCentre)))
            * (1.0 - smoothstep(0.94, 1.05, radial));
          float rootAttach = smoothstep(-0.035, 0.035 + radial * 0.045, t);
          float spent = 1.0 - smoothstep(0.64, 0.985, t);
          float shearFold = mix(0.92, 0.10 + turbulence * 1.28,
            smoothstep(0.08, 0.74, t));
          float breakup = mix(1.0, smoothstep(0.30, 0.66, turbulence),
            smoothstep(0.44, 0.92, t));
          float mixingLayer = interior * mix(0.58, 0.24, smoothstep(0.12, 0.78, t))
            + shell * mix(0.42, 0.88, smoothstep(0.08, 0.70, t));

          /* Restrained compression cells live only in the hot potential core.
             They modulate radius and radiance together, reading as pressure
             structure rather than a row of glowing sprites. */
          float pressureWave = 0.66 + compression * 0.34;
          float shear = mixingLayer * rootAttach * spent
            * shearFold * breakup * pressureWave;
          float coreRadius = (0.19 + t * 0.13)
            * mix(0.94, 1.10, compression);
          float coreProfile = 1.0 - smoothstep(0.02, coreRadius, radial);
          /* White-hot gas is a compact near-field potential core.  Downstream
             pressure cells remain in the blue mixing flow instead of drawing
             a long straight white laser through the whole plume. */
          float coreAxial = (1.0 - smoothstep(0.30, 0.53, t))
            * exp(-t * 1.55);
          float potentialCore = coreProfile * coreProfile * coreAxial
            * (0.95 + compression * 0.20)
            * smoothstep(-0.050, 0.015, t);
          float weightedShear = shear * (0.060 + drive * 0.098);
          float weightedCore = potentialCore * (0.25 + drive * 0.32);
          float density = weightedShear + weightedCore;
          float sampleAlpha = 1.0 - exp(-density * stepLength * 0.68);
          float coreMix = clamp(weightedCore / max(density, 0.001), 0.0, 1.0);
          float shellMix = clamp(shell * (1.0 - coreMix), 0.0, 1.0);
          vec3 innerBlue = mix(vec3(0.58, 0.82, 1.0), vec3(0.12, 0.30, 0.72),
            smoothstep(0.08, 0.95, t));
          vec3 shellBlue = mix(vec3(0.26, 0.55, 0.96), vec3(0.035, 0.12, 0.42),
            smoothstep(0.10, 0.95, t));
          vec3 shearColor = mix(innerBlue, shellBlue, shellMix * 0.72);
          vec3 coreColor = mix(vec3(0.82, 0.94, 1.0), vec3(0.20, 0.48, 0.92),
            smoothstep(0.10, 0.48, t));
          vec3 sampleColor = mix(shearColor, coreColor, coreMix);
          float radiance = mix(1.24, 0.34, smoothstep(0.08, 0.96, t))
            + coreMix * (0.88 + drive * 0.52 + compression * 0.04);
          float remaining = 1.0 - accumulatedAlpha;
          accumulatedColor += remaining * sampleColor * radiance * sampleAlpha;
          accumulatedAlpha += remaining * sampleAlpha;
        }
        accumulatedAlpha = min(accumulatedAlpha, 0.40);
        gl_FragColor = clamp(vec4(accumulatedColor, accumulatedAlpha), 0.0, 4.0);
        if (accumulatedAlpha < 0.002) discard;
      }`,
  });
}
function haloMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uPower: { value: 0.1 }, uTime: { value: 0 } },
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
      varying float vRadius; varying float vEngineRadius;
      varying vec2 vDisc; varying vec3 vWorld;
      void main(){
        mat4 instance = mat4(1.0);
        #ifdef USE_INSTANCING
          instance = instanceMatrix;
        #endif
        vec4 wp = modelMatrix * instance * vec4(position, 1.0);
        vRadius = length(position.xy);
        vEngineRadius = length(instance[0].xyz);
        vDisc = position.xy;
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uPower; uniform float uTime;
      varying float vRadius; varying float vEngineRadius;
      varying vec2 vDisc; varying vec3 vWorld;
      void main(){
        #include <logdepthbuf_fragment>
        float drive = smoothstep(0.06, 1.7, uPower);
        float gasFill = 1.0 - smoothstep(0.58, 0.86, vRadius);
        float hotCore = exp(-pow((vRadius - 0.27) / 0.085, 2.0));
        float ionRing = exp(-pow((vRadius - 0.52) / 0.10, 2.0));
        float wallRing = exp(-pow((vRadius - 0.72) / 0.075, 2.0));
        float cameraFade = smoothstep(0.35, 1.35, distance(cameraPosition, vWorld));
        float fillAlpha = (0.135 + drive * 0.085) * gasFill;
        float coreAlpha = (0.095 + drive * 0.125) * hotCore;
        float ringAlpha = (0.065 + drive * 0.095) * ionRing;
        float wallAlpha = (0.042 + drive * 0.060) * wallRing;
        float smallEngineBoost = mix(4.50, 1.0,
          smoothstep(0.34, 0.82, vEngineRadius));
        float baseAlpha = fillAlpha + coreAlpha + ringAlpha + wallAlpha;
        float thermal = 0.955 + 0.045
          * sin(vDisc.x * 7.0 + uTime * 3.0)
          * cos(vDisc.y * 8.5 - uTime * 5.0);
        float alpha = baseAlpha * cameraFade * thermal;
        vec3 fillColor = vec3(0.018, 0.070, 0.18);
        vec3 coreColor = vec3(0.38, 0.74, 1.0);
        vec3 ringColor = vec3(0.34, 0.68, 1.0);
        vec3 wallColor = vec3(0.08, 0.35, 0.82);
        vec3 color = (fillColor * fillAlpha + coreColor * coreAlpha
          + ringColor * ringAlpha + wallColor * wallAlpha)
          / max(baseAlpha, 0.001);
        float radiance = (1.10 + drive * 0.62)
          * mix(3.60, 1.0, smoothstep(0.34, 0.82, vEngineRadius));
        float alphaCap = mix(0.82, 0.46,
          smoothstep(0.34, 0.82, vEngineRadius));
        alpha = min(alpha * smallEngineBoost, alphaCap);
        gl_FragColor = clamp(vec4(color * radiance * alpha, alpha), 0.0, 1.8);
        if (alpha < 0.002) discard;
      }`,
  });
}
