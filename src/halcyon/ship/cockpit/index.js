// Cockpit assembly — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/cockpit/index.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { mat } from '../../loft.js';
import { bevelBox } from '../../prims.js';
import { buildShell } from './frame.js';
import { buildStation } from './station.js';
import { buildInstruments } from './holo.js';
import { makeDatum } from './datum.js';

/* ------------------------------------------------------------------ *
 *  COCKPIT
 *
 *  Assembles the shell and the flight station, lights the deck from the
 *  fixtures the LAMPS table declares, and exposes a SIGHT CHECK.
 *
 *  The sight check is the part worth explaining.  The old cockpit's
 *  defect — "乱成一团一堆穿模" — was invisible to the type checker and to
 *  every unit test one could write, because interpenetration is a
 *  property of the geometry, not of the code.  So it gets measured the
 *  way TLS measures its own framing: fire a fan of rays from the eye
 *  through the forward field of view and report anything opaque that is
 *  close enough to be an obstruction.  It turns "does it look right" into
 *  a number, and it is what stops the next hull change from silently
 *  putting a frame member back across the windscreen.
 * ------------------------------------------------------------------ */

export function buildCockpit(M, def) {
  const group = new THREE.Group();
  group.name = 'cockpit';
  const D = makeDatum(def);
  const { EYE, LAMPS, COVE_Y, COVE_Z0, COVE_Z1, PANEL_TOP, GZ_FWD } = D;

  const shell = buildShell(M, D);
  const station = buildStation(M, D);
  group.add(shell.group);
  group.add(station.group);

  /* ---- display faces --------------------------------------------- *
   *  One mesh per bay for now; the instrument pass replaces these with
   *  volumetric holograms and keeps the same transforms. */
  for (const s of station.screens) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h).rotateX(-Math.PI / 2), M.screens[s.kind % M.screens.length]);
    mesh.applyMatrix4(s.m);
    mesh.name = 'mfd';
    group.add(mesh);
  }

  /* ---- lighting -------------------------------------------------- *
   *  Positioned from LAMPS so the lit geometry, the point lights and the
   *  canopy's reflections all agree.  Intensities are low: the cockpit is
   *  a small volume with pale paint, and the previous values were set
   *  against near-black albedo. */
  const lights = [];
  const add = (x, y, z, c, i, d) => {
    const l = new THREE.PointLight(c, i, d, 2);
    l.position.set(x, y, z);
    group.add(l);
    lights.push(l);
  };
  for (const l of LAMPS.slice(0, 2)) {
    /* two along each cove: one lamp for a 1.2 m strip pools too hard */
    for (const t of [0.3, 0.7]) {
      const p = new THREE.Vector3().lerpVectors(l.a, l.b, t);
      add(p.x, p.y - 0.06, p.z, 0xffd7b0, 1.5, 3.4);
    }
  }
  /* the coaming wash: the light that makes a panel readable */
  add(0, PANEL_TOP.x + 0.03, PANEL_TOP.y + 0.34, 0xfff0da, 0.75, 2.2);
  /* a cold fill from the overhead lip, so the deck is not one temperature */
  add(0, COVE_Y - 0.2, (COVE_Z0 + COVE_Z1) / 2 + 0.1, 0xcfe2ff, 0.9, 3.0);
  /* nose bay, forward and low — reads as light coming up off the glazing */
  add(0, 0.5, GZ_FWD + 0.5, 0x9fc4ff, 0.7, 2.6);

  /* ---- forward nose-bay closure below the windscreen -------------- */
  const closure = new THREE.Mesh(bevelBox(2.2, 0.34, 0.14, 0.02), M.blackMetal);
  closure.applyMatrix4(mat(0, 0.20, GZ_FWD + 0.06));
  group.add(closure);

  /* the volumetric instrument layer, over the same bay transforms the flat
     MFD faces use, so a hologram sits in its own well rather than beside it */
  const holo = buildInstruments(station.screens);
  group.add(holo.group);

  const solid = [...shell.solid, ...station.solid, closure];

  return {
    group,
    datum: D,
    lights,
    screens: station.screens,
    glass: shell.glass,
    holo,
    sightCheck: () => sightCheck(solid, EYE),
    probeRay: (az, el) => probeRay(group, az, el, EYE),
  };
}

/**
 * Everything one ray passes through, transparent geometry included.
 *
 * Recurses the whole cockpit group rather than the `solid` list, so the
 * glazing, the MFD faces and the emissive strips all show up.
 */
function probeRay(group, azDeg, elDeg, EYE) {
  const a = (azDeg * Math.PI) / 180, e = (elDeg * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(a) * Math.cos(e),
    Math.sin(e),
    -Math.cos(a) * Math.cos(e),
  );
  const ray = new THREE.Raycaster(EYE.clone(), dir, 0.01, 40);
  return ray.intersectObject(group, true).map((h) => {
    const m = h.object.material;
    const name = Array.isArray(m) ? 'multi' : (m.name || m.type);
    return {
      name: h.object.name || h.object.type,
      dist: +h.distance.toFixed(3),
      y: +h.point.y.toFixed(3),
      z: +h.point.z.toFixed(3),
      material: name,
    };
  });
}

/* ------------------------------------------------------------------ */
function sightCheck(solid, EYE) {
  const ray = new THREE.Raycaster();
  ray.far = 4.0;
  const hits = [];
  let blocked = 0;
  let total = 0;

  /* a fan over the working field of view: 45 degrees either side, and from
     8 degrees up to 30 degrees down, which is where a pilot actually looks */
  for (let az = -45; az <= 45; az += 3) {
    for (let el = 8; el >= -30; el -= 2) {
      total++;
      const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
      const dir = new THREE.Vector3(
        Math.sin(a) * Math.cos(e),
        Math.sin(e),
        -Math.cos(a) * Math.cos(e),
      );
      ray.set(EYE, dir);
      const hit = ray.intersectObjects(solid, false)[0];
      if (hit) {
        blocked++;
        hits.push({ object: hit.object.name, dist: +hit.distance.toFixed(3), azDeg: az, elDeg: el });
      }
    }
  }
  hits.sort((p, q) => p.dist - q.dist);

  /* clear down-vision: sweep straight ahead until something blocks */
  let downVision = 0;
  for (let el = 0; el >= -40; el -= 0.5) {
    const e = (el * Math.PI) / 180;
    ray.set(EYE, new THREE.Vector3(0, Math.sin(e), -Math.cos(e)));
    if (ray.intersectObjects(solid, false).length) break;
    downVision = -el;
  }

  return { blocked: total ? blocked / total : 0, hits: hits.slice(0, 12), downVision };
}
