// HALCYON-VII surface dressing — ported 1:1 from
// 3aaa-spaceship-flight-prototype/src/game/ship/ships/halcyon-dress.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { xf, mat, sectionAt, ringPoint, sweepProfile, rectProfile } from '../../loft.js';
import { bevelBox, wedge, lathe, rcsPort, louvreVent, recessPanel, greebleField, frameRect } from '../../prims.js';

/* ==================================================================== *
 *  HALCYON-VII  —  SURFACE DRESSING
 *
 *  Everything that makes this particular hull look like a used machine
 *  rather than a lofted shape: the nose sensor suite, panel lines, dorsal
 *  spine, docking collar, wing pods and tip booms, nacelle radiators, fin
 *  cap and beacon.
 *
 *  It lives with the def rather than in exterior.js because none of it
 *  generalises.  The blisters are at z -11.35 because that is where THIS
 *  windscreen starts; the spine runs -4.4 to 4.8 because that is where THIS
 *  hull is widest.  A parameter for each would be the same number with a
 *  longer name, and the previous arrangement — all of it inline in the
 *  shared builder, closing over one imported blueprint — is exactly why the
 *  exterior could only ever build one ship.
 *
 *  Everything is placed through ctx.onTop / onBelly / onSide / onSkin,
 *  which return a frame sitting ON the skin at that station with +Y along
 *  the outward normal.  Nothing here carries an absolute triple, so the
 *  dressing follows the hull if the section table changes.
 * ==================================================================== */
export function dressHalcyon(ctx) {
  const { B, M, group, strobes, onTop, onBelly, onSide, onSkin, nacTop, nacBelly, nacSide } = ctx;
  const HULL = ctx.hull, WING = ctx.wing;
  const UP = new THREE.Vector3(0, 1, 0);

  /* ---- canopy frame end fittings ---- */
  for (const sx of [-1, 1]) {
    B.add('darkMetal', xf(bevelBox(0.13, 0.52, 0.15, 0.025), mat(sx * 1.05, 2.56, -5.12, 0.45, 0, 0)));
    B.add('brushed', xf(new THREE.CylinderGeometry(0.045, 0.045, 0.44, 10), mat(sx * 1.05, 2.36, -4.93, 0.45, 0, 0)));
  }

  /* ============ NOSE ============ */
  B.add('blackMetal', xf(wedge(0.62, 0.26, 1.5, 0.5, 0.03), mat(0, 0.03, -14.5, 0.16, 0, 0)));
  for (let i = 0; i < 3; i++) {
    B.add('glowCyan', xf(new THREE.SphereGeometry(0.05, 12, 8), mat(-0.15 + i * 0.15, 0.13, -14.86 + i * 0.05)));
  }
  B.add('copper', xf(lathe([[0.02, 0], [0.09, 0.02], [0.09, 0.1], [0.04, 0.14]], 16), mat(0, 0.16, -13.75)));
  B.addParts(recessPanel(1.1, 1.9, 0.055), onTop(-12.5, 0));
  B.add('darkMetal', xf(greebleField(0.86, 1.55, 12, 88, 0.07), onTop(-12.5, 0, 0.006)));
  /* Antennae live BEHIND the canopy — anything vertical forward of the
     windscreen sits straight in the pilot's field of view. */
  for (const sx of [-1, 1]) {
    B.add('brushed', xf(new THREE.CylinderGeometry(0.013, 0.022, 0.72, 6), onTop(-4.15, sx * 0.72, 0.36)));
    B.add('darkMetal', xf(lathe([[0.07, 0], [0.08, 0.03], [0.05, 0.06]], 12), onTop(-4.15, sx * 0.72, 0)));
    B.add('glowRed', xf(new THREE.SphereGeometry(0.026, 8, 6), onTop(-4.15, sx * 0.72, 0.72)));
  }
  /* low-profile forward sensor blisters — flush, never breaks the sight line */
  for (const sx of [-1, 1]) {
    B.add('darkMetal', xf(wedge(0.34, 0.12, 0.66, 0.55, 0.03), onTop(-11.35, sx * 0.62, 0.045)));
    B.add('glowCyan', xf(bevelBox(0.16, 0.012, 0.3, 0.004), onTop(-11.35, sx * 0.62, 0.108)));
  }
  B.add('blackMetal', xf(wedge(1.2, 0.2, 1.7, 0.62, 0.03), onBelly(-12.2, 0, 0.06)));
  for (const sx of [-1, 1]) {
    B.add('darkMetal', xf(lathe([[0.14, 0], [0.16, 0.05], [0.1, 0.09]], 14), onBelly(-11.4, sx * 0.5, 0.02)));
    B.add('glowWarm', xf(new THREE.CircleGeometry(0.095, 14).rotateX(-Math.PI / 2), onBelly(-11.4, sx * 0.5, 0.055)));
  }
  for (const z of [-13.6, -12.0]) {
    B.addParts(rcsPort(0.1), onTop(z, 0.3), true);
    B.addParts(rcsPort(0.1), onBelly(z, 0.3), true);
    B.addParts(rcsPort(0.11), onSkin(z, 12), true);
  }

  /* ============ HULL SURFACE DETAIL ============ */
  {
    const path = [];
    const ups = [];
    for (let z = -4.4; z <= 4.8; z += 0.35) {
      path.push(new THREE.Vector3(0, sectionAt(HULL, z).yTop, z)); ups.push(UP.clone());
    }
    B.add('darkMetal', sweepProfile(path, ups, rectProfile(0.19, 0.07, 0.4)));
    for (let z = -4.1; z <= 4.6; z += 0.86) {
      B.add('brushed', xf(bevelBox(0.3, 0.05, 0.1, 0.012), onTop(z, 0, 0.095)));
    }
  }
  // dorsal cargo doors, split around the spine
  for (const sx of [-1, 1]) {
    B.addParts(recessPanel(1.05, 2.2, 0.055), onTop(2.2, sx * 0.75));
    B.add('trim', xf(frameRect(1.05, 2.2, 0.06, 0.045), onTop(2.2, sx * 0.75, 0.018)));
    B.add('brushed', xf(bevelBox(0.5, 0.06, 0.12, 0.015), onTop(2.2, sx * 0.75, 0.045)));
  }
  // ventral docking collar
  B.add('darkMetal', xf(lathe([[0.6, 0], [0.66, 0.05], [0.72, 0.07], [0.72, 0.17], [0.6, 0.21], [0.56, 0.1], [0.54, 0]], 28), onBelly(-2.6, 0)));
  B.add('blackMetal', xf(new THREE.CircleGeometry(0.54, 24).rotateX(-Math.PI / 2), onBelly(-2.6, 0, 0.07)));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    B.add('brushed', xf(bevelBox(0.07, 0.08, 0.14, 0.015),
      onBelly(-2.6, 0, 0.1).multiply(mat(Math.cos(a) * 0.66, 0, Math.sin(a) * 0.66, 0, -a, 0))));
  }
  for (const z of [-4.8, -2.6, 0.4, 3.4]) B.addParts(recessPanel(1.15, 1.5, 0.045), onSide(z, 1.15), true);
  for (const z of [-3.6, 1.6]) B.addParts(louvreVent(0.72, 1.0, 5), onSide(z, 0.1), true);
  B.addSym('darkMetal', xf(greebleField(0.85, 1.3, 10, 12, 0.06), onSide(4.4, 0.6, 0.006)));
  for (const z of [-8.6, 0.0, 4.6]) {
    B.addParts(recessPanel(1.55, 1.3, 0.05), onBelly(z, 0));
    B.add('trim', xf(frameRect(1.55, 1.3, 0.055, 0.04), onBelly(z, 0, 0.014)));
  }
  for (const sx of [-1, 1]) B.addParts(recessPanel(0.95, 1.85, 0.05), onBelly(2.4, sx * 1.12));
  for (const sx of [-1, 1]) {
    const path = [];
    const ups = [];
    for (let z = -7.5; z <= 4.6; z += 0.4) {
      const rp = ringPoint(sectionAt(HULL, z), 17, 'z', 0);
      rp.pos.x *= sx; rp.normal.x *= sx;
      path.push(rp.pos); ups.push(rp.normal);
    }
    B.add('hullDark', sweepProfile(path, ups, rectProfile(0.1, 0.15, 0.3)));
  }
  for (const z of [-4.6, 5.4]) {
    B.addParts(rcsPort(0.13), onTop(z, 1.0), true);
    B.addParts(rcsPort(0.13), onBelly(z, 1.1), true);
  }
  for (const z of [-5.6, 4.6]) B.addParts(rcsPort(0.135), onSide(z, 0.55), true);

  /* ============ WING PODS, VENTS AND TIP BOOMS ============ */
  for (const px of [5.3, 7.6]) {
    const s = sectionAt(WING, px);
    const yb = s.yBot, zc = s.off ?? 0;
    B.addSym('darkMetal', xf(bevelBox(0.42, 0.4, 2.1, 0.09), mat(px, yb - 0.15, zc + 0.35)));
    B.addSym('blackMetal', xf(lathe([[0.02, -0.5], [0.13, -0.36], [0.2, 0], [0.13, 0.36], [0.02, 0.48]], 16).rotateX(Math.PI / 2), mat(px, yb - 0.15, zc - 1.0)));
    B.addSym('trim', xf(bevelBox(0.36, 0.14, 0.5, 0.03), mat(px, yb + 0.02, zc + 0.3)));
    B.addSym('glowAmber', xf(new THREE.CircleGeometry(0.05, 10).rotateX(Math.PI / 2), mat(px, yb - 0.352, zc + 0.9)));
  }
  for (const px of [4.2, 6.4, 8.4]) {
    const s = sectionAt(WING, px);
    B.addSym('darkMetal', xf(greebleField(0.66, 1.1, 8, 300 + px * 7, 0.05), mat(px, s.yTop - 0.008, (s.off ?? 0) + 0.55)));
    B.addParts(louvreVent(0.46, 0.72, 4), mat(px, s.yTop, (s.off ?? 0) - 0.7), true);
  }
  const tip = sectionAt(WING, 10.7);
  const tz = tip.off ?? 0;
  const tipY = (tip.yTop + tip.yBot) / 2;
  for (const sx of [-1, 1]) {
    B.add('hullDark', xf(bevelBox(0.34, 0.34, 2.3, 0.1), mat(sx * 10.68, tipY, tz - 0.1)));
    B.add('darkMetal', xf(lathe([[0.02, -1.35], [0.1, -1.2], [0.16, -0.85], [0.17, 0.85], [0.1, 1.15], [0.02, 1.25]], 14).rotateX(Math.PI / 2), mat(sx * 10.68, tipY, tz - 0.1)));
    B.add('hull', xf(wedge(0.15, 1.0, 1.45, 0.42, 0.05), mat(sx * 10.68, tipY + 0.48, tz + 0.3, 0, 0, sx * 0.2)));
    B.add('hullAccent', xf(wedge(0.165, 0.28, 1.25, 0.5, 0.03), mat(sx * 10.68, tipY + 0.86, tz + 0.36, 0, 0, sx * 0.2)));
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 10), sx < 0 ? M.glowRed : M.glowGreen);
    lamp.position.set(sx * 10.68, tipY, tz - 1.32);
    group.add(lamp);
    const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), M.glowWarm.clone());
    strobe.position.set(sx * 10.68, tipY + 0.02, tz + 1.05);
    group.add(strobe);
    strobes.push(strobe);
    B.addParts(rcsPort(0.09), mat(sx * 10.62, tipY + 0.18, tz + 0.75));
  }

  /* ============ NACELLE DETAIL ============ */
  for (const z of [1.9, 3.0]) B.addParts(louvreVent(0.95, 0.48, 4), nacTop(z, 0, 0, Math.PI / 2), true);
  for (let i = 0; i < 4; i++) {
    const z = 4.5 + i * 1.05;
    B.addSym('trim', xf(bevelBox(0.16, 0.34, 0.7, 0.03), nacTop(z, 0, 0.06)));
    B.addSym('darkMetal', xf(bevelBox(1.3, 0.055, 0.7, 0.02), nacTop(z, 0, 0.17)));
    B.addSym('glowAmber', xf(bevelBox(1.16, 0.012, 0.05, 0.004), nacTop(z, 0, 0.135)));
  }
  for (const z of [3.4, 5.6, 7.8]) B.addParts(recessPanel(1.35, 0.9, 0.045), nacSide(z, 0.72, true, 0, Math.PI / 2), true);
  B.addSym('darkMetal', xf(greebleField(1.45, 0.85, 11, 501, 0.06), nacSide(9.4, 0.85, true, 0.006, Math.PI / 2)));
  for (let i = 0; i < 5; i++) {
    const z = 4.0 + i * 1.3;
    B.addSym('blackMetal', xf(bevelBox(0.05, 0.1, 0.55, 0.012), nacSide(z, 1.12, false, 0.02)));
    B.addSym('glowCyan', xf(bevelBox(0.022, 0.05, 0.45, 0.006), nacSide(z, 1.12, false, 0.055)));
  }
  for (const z of [3.0, 8.2]) {
    B.addSym('darkMetal', xf(bevelBox(0.82, 0.22, 1.1, 0.06), nacBelly(z, 0, 0.09)));
    B.addParts(recessPanel(0.6, 0.8, 0.04), nacBelly(z, 0, 0.2), true);
  }
  for (const z of [2.4, 10.0]) {
    B.addParts(rcsPort(0.12), nacTop(z, 0.4), true);
    B.addParts(rcsPort(0.12), nacBelly(z, 0.4), true);
    B.addParts(rcsPort(0.12), nacSide(z, 0.68, true), true);
  }

  /* ============ FIN CAP AND BEACON ============ */
  B.add('darkMetal', xf(bevelBox(0.32, 0.46, 1.45, 0.07), mat(0, 6.12, 9.15)));
  B.add('brushed', xf(new THREE.CylinderGeometry(0.028, 0.028, 1.0, 8), mat(0, 6.8, 9.0)));
  for (let i = 0; i < 3; i++) {
    B.add('darkMetal', xf(bevelBox(0.88 - i * 0.16, 0.14, 0.42, 0.03), mat(0, 3.1 + i * 0.85, 6.9 + i * 0.4)));
  }
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 10), M.glowRed.clone());
  beacon.position.set(0, 6.34, 9.96);
  group.add(beacon);
  strobes.push(beacon);

  /* ============ ENGINE DECK GREEBLE ============ */
  B.add('darkMetal', xf(greebleField(1.9, 0.5, 9, 777, 0.07), mat(0, 2.84, 11.01, Math.PI / 2, 0, 0)));
  for (const sx of [-1, 1]) B.addParts(rcsPort(0.11), mat(sx * 1.85, 2.84, 11.01, Math.PI / 2, 0, 0));
}
