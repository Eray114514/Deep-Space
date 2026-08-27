// Hard-surface primitives — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/prims.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { creaseNormals, mergeGeos, xf, mat } from './loft.js';

/* ------------------------------------------------------------------ *
 *  HARD-SURFACE PRIMITIVES
 *  Everything is bevelled — a raw 90° cube edge instantly reads as
 *  "untextured prototype", so no un-bevelled box is used anywhere on
 *  the ship.
 * ------------------------------------------------------------------ */

function ring8(hw, hh, c) {
  const cx = Math.min(c, hw * 0.49);
  const cy = Math.min(c, hh * 0.49);
  return [
    new THREE.Vector2(-hw + cx, hh), new THREE.Vector2(hw - cx, hh),
    new THREE.Vector2(hw, hh - cy), new THREE.Vector2(hw, -hh + cy),
    new THREE.Vector2(hw - cx, -hh), new THREE.Vector2(-hw + cx, -hh),
    new THREE.Vector2(-hw, -hh + cy), new THREE.Vector2(-hw, hh - cy),
  ];
}

/** bevelled box centred at the origin */
export function bevelBox(w, h, d, c = 0.02) {
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const cz = Math.min(c, hd * 0.49);
  const slices = [
    { z: -hd, ring: ring8(hw - c, hh - c, c) },
    { z: -hd + cz, ring: ring8(hw, hh, c) },
    { z: hd - cz, ring: ring8(hw, hh, c) },
    { z: hd, ring: ring8(hw - c, hh - c, c) },
  ];
  const P = [];
  const U = [];
  const add = (x, y, z, u, v) => { P.push(x, y, z); U.push(u, v); };
  for (let s = 0; s < slices.length - 1; s++) {
    const a = slices[s], b = slices[s + 1];
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      const p0 = a.ring[i], p1 = a.ring[j], p2 = b.ring[j], p3 = b.ring[i];
      const u0 = i / 8, u1 = (i + 1) / 8, v0 = s / 3, v1 = (s + 1) / 3;
      add(p0.x, p0.y, a.z, u0, v0); add(p2.x, p2.y, b.z, u1, v1); add(p1.x, p1.y, a.z, u1, v0);
      add(p0.x, p0.y, a.z, u0, v0); add(p3.x, p3.y, b.z, u0, v1); add(p2.x, p2.y, b.z, u1, v1);
    }
  }
  /* END CAPS.
     The `front` flag was the wrong way round, and it put every bevelBox in
     the ship — thousands of them, inside and out — inside-out on BOTH Z
     ends.  Working it through for the -Z cap: ring8 runs clockwise seen from
     +Z, so a fan a -> c2 -> b has winding normal +Z, which faces INTO the
     solid at z = -hd.  The two caps therefore have to fan the other way from
     each other, and the -Z one is the "front" order:

       slices[0] at z = -hd  needs an outward normal of -Z  -> a, b, c2
       slices[3] at z = +hd  needs an outward normal of +Z  -> a, c2, b

     Because creaseNormals() derives the normals FROM the winding, the caps'
     normals were reversed too, which is why a winding-vs-normal audit passed:
     both halves of the pair were consistently wrong.  What it looked like was
     a box with two missing faces that reappeared when you walked round it —
     the far cap showing through where the near one was culled. */
  for (const [sl, front] of [[slices[0], true], [slices[3], false]]) {
    for (let i = 1; i < 7; i++) {
      const a = sl.ring[0], b = sl.ring[i], c2 = sl.ring[i + 1];
      if (front) {
        add(a.x, a.y, sl.z, 0, 0); add(b.x, b.y, sl.z, 1, 0); add(c2.x, c2.y, sl.z, 1, 1);
      } else {
        add(a.x, a.y, sl.z, 0, 0); add(c2.x, c2.y, sl.z, 1, 1); add(b.x, b.y, sl.z, 1, 0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  creaseNormals(g, 32);
  return g;
}

/** flat trapezoid slab — used for hull blisters and vents */
export function wedge(w, h, d, taper = 0.6, c = 0.015) {
  const g = bevelBox(w, h, d, c);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y / (h / 2)) * 0.5 + 0.5;
    const k = 1 - (1 - taper) * t;
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
  }
  creaseNormals(g, 32);
  return g;
}

export function cyl(rt, rb, h, seg = 16, open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
  return g;
}

/**
 * Lathe a profile about the Y axis.
 *
 * `flip` reverses the winding, which is the difference between a surface you
 * can see from OUTSIDE the axis and one you can see from INSIDE it.  A lathe
 * whose profile runs monotonically outward faces outward, so an engine bell's
 * throat built that way is invisible from astern — you look into the nozzle
 * and see the far wall of the pod through it, which is precisely why the
 * drive read as a pale ring with an empty hole in the middle.  creaseNormals
 * derives normals from the winding, so reversing the triangles carries the
 * normals with it and the two cannot disagree.
 */
export function lathe(pts, seg = 32, flip = false) {
  const g = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(Math.max(1e-4, x), y)), seg);
  const n = g.toNonIndexed();
  if (flip) {
    const p = n.getAttribute('position');
    const a = p.array;
    for (let i = 0; i < p.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const t = a[(i + 1) * 3 + k]; a[(i + 1) * 3 + k] = a[(i + 2) * 3 + k]; a[(i + 2) * 3 + k] = t;
      }
    }
    const uv = n.getAttribute('uv');
    if (uv) {
      const u = uv.array;
      for (let i = 0; i < uv.count; i += 3) {
        for (let k = 0; k < 2; k++) {
          const t = u[(i + 1) * 2 + k]; u[(i + 1) * 2 + k] = u[(i + 2) * 2 + k]; u[(i + 2) * 2 + k] = t;
        }
      }
    }
  }
  creaseNormals(n, 36);
  return n;
}

/* ------------------------------------------------------------------ *
 *  Composite detail generators
 * ------------------------------------------------------------------ */

/** recessed RCS manoeuvring port: housing + inner cone + glow disc */
export function rcsPort(r) {
  const housing = lathe([
    [r * 1.28, 0.0], [r * 1.28, -0.03], [r * 1.02, -0.055],
    [r * 0.98, -0.10], [r * 0.62, -0.16], [r * 0.6, -0.2],
  ], 14);
  const inner = lathe([[0, -0.20], [r * 0.56, -0.19], [r * 0.9, -0.10]], 14);
  const glow = new THREE.CircleGeometry(r * 0.55, 14);
  glow.rotateX(-Math.PI / 2);
  glow.translate(0, -0.185, 0);
  return [
    { geo: housing, mat: 'darkMetal' },
    { geo: inner, mat: 'blackMetal' },
    { geo: glow, mat: 'glowCyan' },
  ];
}

/** flush louvre vent set into the skin */
export function louvreVent(w, d, n = 4) {
  const out = [];
  out.push({ geo: xf(bevelBox(w, 0.05, d, 0.012), mat(0, -0.055, 0)), mat: 'blackMetal' });
  for (let i = 0; i < n; i++) {
    const z = -d / 2 + (d / (n + 1)) * (i + 1);
    out.push({
      geo: xf(bevelBox(w * 0.9, 0.035, d / (n + 1) * 0.55, 0.008), mat(0, -0.028, z, 0.5, 0, 0)),
      mat: 'darkMetal',
    });
  }
  out.push({ geo: xf(frameRect(w, d, 0.035, 0.03), mat(0, -0.01, 0)), mat: 'trim' });
  return out;
}

/** rectangular frame ring (4 bevelled bars) lying in the XZ plane */
export function frameRect(w, d, t, h) {
  const parts = [
    xf(bevelBox(w + t * 2, h, t, 0.008), mat(0, 0, -d / 2 - t / 2)),
    xf(bevelBox(w + t * 2, h, t, 0.008), mat(0, 0, d / 2 + t / 2)),
    xf(bevelBox(t, h, d, 0.008), mat(-w / 2 - t / 2, 0, 0)),
    xf(bevelBox(t, h, d, 0.008), mat(w / 2 + t / 2, 0, 0)),
  ];
  return mergeGeos(parts);
}

/** recessed hull panel: a shallow inset tray with a lip */
export function recessPanel(w, d, depth = 0.05) {
  return [
    { geo: xf(bevelBox(w, depth, d, 0.01), mat(0, -depth / 2 - 0.005, 0)), mat: 'hullDark' },
    { geo: xf(frameRect(w, d, 0.045, 0.03), mat(0, -0.012, 0)), mat: 'trim' },
  ];
}

/**
 * ENGINE BELL — flared nozzle, cooling ribs, injector face, deep core.
 *
 * The old version put a wide glowing cone (R*0.66 at the mouth) 12 cm inside
 * a 0.36-deep bell, so from astern the whole aperture was one flat disc: a
 * dark ring with a lighter disc in it, which is what read as 假.  A real bell
 * reads by DEPTH — you see a converging throat, the ribs down its wall
 * catching light at different angles, and the fire a long way in.  So:
 *
 *   - the throat now converges to R*0.17 at y = -0.62, nearly a metre of
 *     visible depth on a 1 m engine instead of 12 cm;
 *   - 24 radial cooling ribs run down the inside of the bell, which is the
 *     single cue that says "nozzle" at any distance;
 *   - the injector face at the bottom is a hub with spokes, so the hot part
 *     is BEHIND something rather than being the first surface you meet;
 *   - the glow is a small deep disc plus a thin ring at the throat, so the
 *     light comes out of a hole instead of being painted across the mouth.
 */
export function engineBell(R) {
  const p = [];
  /* outer casing: a real flared bell with a rolled lip at the mouth */
  p.push({
    geo: lathe([
      [R * 0.86, -1.55], [R * 0.9, -1.2], [R * 0.82, -0.85], [R * 0.8, -0.4],
      [R * 0.86, -0.1], [R * 1.0, 0.12], [R * 1.08, 0.3], [R * 1.10, 0.38],
      [R * 1.02, 0.40], [R * 0.96, 0.32], [R * 0.88, 0.12], [R * 0.80, -0.2],
      [R * 0.74, -0.9], [R * 0.70, -1.55],
    ], 44),
    mat: 'nozzle',
  });
  // heat shroud rings, stepping out as they go aft
  for (let i = 0; i < 3; i++) {
    const y = -0.05 + i * 0.13;
    const rr = R * (0.9 + i * 0.055);
    p.push({ geo: lathe([[rr, y], [rr + 0.045, y + 0.012], [rr + 0.045, y + 0.05], [rr, y + 0.062]], 36), mat: 'darkMetal' });
  }
  /* THE THROAT.  Converging, dark, deep — and FLIPPED, because this is a
     surface you see from inside the axis.  Unflipped it faced the hull it is
     buried in, so from astern the bell was an empty hole. */
  p.push({
    geo: lathe([
      [R * 0.17, -0.62], [R * 0.24, -0.50], [R * 0.36, -0.30],
      [R * 0.52, -0.02], [R * 0.68, 0.16], [R * 0.86, 0.32],
    ], 40, true),
    mat: 'blackMetal',
  });
  /* the hot band on the throat wall: the one thing that makes a nozzle read
     as running rather than as a hole, and it has to be flipped for the same
     reason the throat is */
  p.push({ geo: lathe([[R * 0.175, -0.58], [R * 0.30, -0.36], [R * 0.44, -0.14]], 40, true), mat: 'engineCore' });
  /* cooling ribs down the inside of the bell wall.
     The rib runs from (rIn, yIn) to (rOut, yOut) in the meridian plane at
     angle a, so its axis is (cos a sin k, cos k, sin a sin k) with
     k = atan2(dr, dy).  R_x(k) tilts local +Y into (0, cos k, sin k) and then
     R_y(PI/2 - a) carries that to the wanted triple — that pair, in that
     order, is the only combination that does; R_y(-a) after R_x(-k) puts the
     rib 90 degrees round the bell from its own meridian. */
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const rIn = R * 0.30, rOut = R * 0.80;
    const yIn = -0.38, yOut = 0.28;
    const rm = (rIn + rOut) * 0.5, ym = (yIn + yOut) * 0.5;
    const len = Math.hypot(rOut - rIn, yOut - yIn);
    const k = Math.atan2(rOut - rIn, yOut - yIn);
    p.push({
      geo: xf(bevelBox(0.022, len, 0.055, 0.006),
        mat(Math.cos(a) * rm, ym, Math.sin(a) * rm)
          .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2 - a))
          .multiply(new THREE.Matrix4().makeRotationX(k))),
      mat: 'darkMetal',
    });
  }
  /* injector face: hub, spokes, and the fire behind them */
  p.push({ geo: lathe([[0, -0.68], [R * 0.16, -0.66], [R * 0.18, -0.62]], 24), mat: 'darkMetal' });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    p.push({
      geo: xf(bevelBox(0.018, 0.02, R * 0.30, 0.004),
        mat(Math.cos(a) * R * 0.11, -0.60, Math.sin(a) * R * 0.11, 0, -a, 0)),
      mat: 'brushed',
    });
  }
  /* THE LIP.  A perfectly circular pale annulus is the strongest toy cue an
     engine can have, so the mouth gets a dark rolled edge and twelve cooling
     scallops cut across it — the outline stops being a clean circle and the
     aperture reads as bounded by something rather than fading into the pod. */
  p.push({ geo: lathe([[R * 1.10, 0.38], [R * 1.13, 0.40], [R * 1.09, 0.425], [R * 1.00, 0.415]], 44), mat: 'blackMetal' });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
    p.push({
      geo: xf(bevelBox(0.05, 0.06, 0.16, 0.012),
        mat(Math.cos(a) * R * 1.07, 0.40, Math.sin(a) * R * 1.07, 0, -a, 0)),
      mat: 'darkMetal',
    });
  }
  /* the core: a disc deep in the throat plus a ring at its waist, so the
     aperture glows from inside instead of being a lit lid on top */
  const core = new THREE.CircleGeometry(R * 0.22, 28);
  core.rotateX(-Math.PI / 2);
  core.translate(0, -0.585, 0);
  p.push({ geo: core, mat: 'engineCore' });
  p.push({ geo: lathe([[R * 0.20, -0.55], [R * 0.27, -0.44]], 30, true), mat: 'engineCore' });
  // actuator struts around the bell
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const rr = R * 0.94;
    p.push({
      geo: xf(bevelBox(0.07, 0.5, 0.09, 0.012), mat(Math.cos(a) * rr, -0.42, Math.sin(a) * rr, 0, -a, 0)),
      mat: 'darkMetal',
    });
    p.push({
      geo: xf(bevelBox(0.1, 0.1, 0.16, 0.02), mat(Math.cos(a) * rr, -0.68, Math.sin(a) * rr, 0, -a, 0)),
      mat: 'brushed',
    });
  }
  // thrust vector petals
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.1;
    const rr = R * 1.02;
    p.push({
      geo: xf(wedge(R * 0.44, 0.3, 0.1, 0.55, 0.012),
        mat(Math.cos(a) * rr, 0.26, Math.sin(a) * rr, Math.PI / 2 - 0.35, 0, 0).premultiply(
          new THREE.Matrix4().makeRotationY(-a))),
      mat: 'darkMetal',
    });
  }
  return { parts: p, coreY: -0.585 };
}

/** braided conduit / hydraulic line following a poly-line */
export function conduit(points, r, seg = 8) {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, Math.max(8, points.length * 5), r, seg, false);
  return g.toNonIndexed();
}

/** a rack of small technical boxes hugging a surface (greeble field) */
export function greebleField(
  w, d, count, seed, maxH = 0.12,
) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const list = [];
  for (let i = 0; i < count; i++) {
    const bw = 0.06 + rnd() * (w * 0.22);
    const bd = 0.06 + rnd() * (d * 0.22);
    const bh = 0.025 + rnd() * maxH;
    const x = (rnd() - 0.5) * (w - bw);
    const z = (rnd() - 0.5) * (d - bd);
    list.push(xf(bevelBox(bw, bh, bd, 0.01), mat(x, bh / 2 - 0.012, z)));
  }
  return mergeGeos(list);
}
