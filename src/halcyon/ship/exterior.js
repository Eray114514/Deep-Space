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
    /* A CONE HAS A STRAIGHT SILHOUETTE, and that is most of what reads as
       fake: an exhaust is a bulging column that necks down, not a triangle.
       So the shells are lathes of a curved envelope — same cost, no straight
       edge anywhere — and both start AT the mouth.

       The old plume was also one cone whose geometry was centred on its own
       origin, so engine.ts scaling its length by throttle (0.35 to 1.3) moved
       the wide end more than a metre fore and aft: at cruise the flame was
       detached from the ship with a gap you could see through, and at full
       power it started inside the nacelle.  Building the profile from y = 0
       makes the scale grow it AFT from the lip, which is what a throttle
       does. */
    const shell = (rad, len, bulge) => {
      const pts = [];
      const N = 14;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const r = rad * Math.pow(1 - t, 0.62) * (1 + bulge * Math.sin(Math.PI * Math.pow(t, 0.8)));
        pts.push([Math.max(0.004, r), t * len]);
      }
      return lathe(pts, 30);
    };
    const addPlume = (m, geo, order) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.rotation.x = Math.PI / 2;       // local +Y -> world +Z, aft
      mesh.position.set(x, y, z + 0.34 * R);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      group.add(mesh);
      plumes.push(mesh);
    };
    addPlume(plumeMaterial(1), shell(R * 0.44, R * 2.8, 0.10), 4);
    addPlume(plumeMaterial(0), shell(R * 0.74, R * 9.0, 0.30), 3);
    /* the halo is a soft ring on the LIP, not a washer over the aperture.
       At RingGeometry(0.30R, 1.06R) it covered the whole mouth in flat
       additive blue, which is what turned the nozzle into a pale disc. */
    const ring = new THREE.Mesh(new THREE.RingGeometry(R * 0.52, R * 1.20, 36), haloMaterial());
    ring.position.set(x, y, z + 0.44 * R);
    ring.renderOrder = 5;
    group.add(ring);
    glowRings.push(ring);
  };
  for (const e of def.engines) mkEngine(e.x, e.y, e.z, e.r);

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

/* ---- engine plume / halo shaders ----
 *
 *  NOTE ON THE `clamp(vUv)` GUARD — this used to black out the whole screen.
 *
 *  The chase camera lerps from the cockpit out to ~23 units behind the ship,
 *  which drives it straight THROUGH these plume cones (they are 7.5 m long,
 *  frustumCulled = false, DoubleSide, depthWrite off).  A triangle that
 *  straddles the near plane interpolates 1/w through zero, so `vUv` arrives
 *  as +/-Inf on those pixels.  `pow(Inf, 0.55)` is +Inf, `mix()` turns that
 *  into a -Inf colour (R/G only — B survives because both endpoints are 1.0
 *  and the compiler folds the delta to zero), and UnrealBloomPass then smears
 *  that -Inf across every pixel of the frame through its downsample chain.
 *  Result: a full black flash, measured at 43% of frames in chase view.
 *
 *  Fixes: clamp the varying before any use, use sqrt() instead of an
 *  unguarded pow(), keep the hash argument bounded so sin() never receives a
 *  huge value after a long session, clamp the output, and fade the plume out
 *  as the camera enters it (uFade, driven from the view controller).
 */
function plumeMaterial(inner) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 0.3 }, uFade: { value: 1 }, uInner: { value: inner } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
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
      uniform float uTime; uniform float uPower; uniform float uFade; uniform float uInner;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      float h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
      void main(){
        #include <logdepthbuf_fragment>
        vec2 uv = clamp(vUv, 0.0, 1.0);
        float t = uv.y;                       /* 0 at the mouth, 1 at the tip */

        /* SHELL THICKNESS, not an angular gradient.
           uv.x on a cone runs AROUND it, so the old smoothstep on
           abs(uv.x-0.5) darkened one side of the plume and put a bright seam
           down the other — a lit strip rotating with the camera, which is a
           large part of why the exhaust read as a painted triangle.  What a
           thin emissive shell actually does is brighten where you look along
           it, so the term is 1/|dot(n,v)|: dim through the middle, bright at
           the silhouette, which integrates to a volume. */
        float ndv = abs(dot(normalize(vN), normalize(vV)));
        float shell = clamp(0.16 / max(ndv, 0.055), 0.0, 3.4);

        /* SHOCK DIAMONDS: an over-expanded nozzle repeats its Mach node with
           a spacing that grows downstream and a strength that decays. */
        float node = sin(6.28318 * (pow(t, 0.72) * 5.5) - 1.2);
        float dia = pow(max(node, 0.0), 3.0) * exp(-t * 5.5);

        float tick = floor(mod(uTime, 64.0) * 40.0);
        float flick = 0.86 + 0.14 * sin(mod(uTime, 64.0) * 47.0 + t * 22.0)
                    + 0.09 * h(vec2(floor(t * 30.0), tick));
        /* turbulent break-up, stronger the further from the throat */
        float turb = mix(1.0, 0.55 + 0.75 * h(vec2(floor(t * 26.0), floor(uv.x * 18.0) + tick * 0.5)), t * t);

        if (uInner > 0.5) {
          /* inner barrel: white hot, short, mostly opaque near the throat */
          float core = smoothstep(1.0, 0.0, t);
          float a = (core * core * 0.62 + dia * 0.9) * flick * uPower * uFade * mix(1.0, shell, 0.35);
          vec3 c = mix(vec3(1.0, 0.99, 0.97), vec3(0.55, 0.85, 1.0), sqrt(t));
          gl_FragColor = clamp(vec4(c * a * 3.1, a * 0.85), 0.0, 32.0);
        } else {
          /* outer envelope: long, translucent, edge-lit, fading to nothing */
          float body = smoothstep(1.0, 0.02, t) * (0.35 + 0.65 * smoothstep(0.0, 0.10, t));
          float a = body * shell * turb * flick * uPower * 0.42 * uFade;
          vec3 c = mix(vec3(0.72, 0.90, 1.0), vec3(0.09, 0.26, 0.86), pow(t, 0.7));
          gl_FragColor = clamp(vec4(c * a * 2.0, a * 0.7), 0.0, 32.0);
        }
      }`,
  });
}
function haloMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uPower: { value: 0.3 }, uFade: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      void main(){
        vUv=uv;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
        #include <logdepthbuf_vertex>
      }`,
    /* RingGeometry's uv.y runs 0 at the inner radius to 1 at the outer, so the
       halo can peak on the lip and fall away both ways instead of being a flat
       washer of light across the aperture. */
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uPower; uniform float uFade; varying vec2 vUv;
      void main(){
        #include <logdepthbuf_fragment>
        float r = clamp(vUv.y, 0.0, 1.0);
        float f = exp(-pow((r - 0.30) / 0.34, 2.0));
        float a = clamp(uPower, 0.0, 4.0) * 0.55 * f * uFade;
        vec3 c = mix(vec3(0.80, 0.94, 1.0), vec3(0.16, 0.40, 1.0), r);
        gl_FragColor = clamp(vec4(c * a * 2.0, a * 0.8), 0.0, 32.0);
      }`,
  });
}
