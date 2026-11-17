// Pure-CPU contracts for the space-fold portal (src/portal/). No GL: geometry,
// choreography, far-view pass ownership and the cloud history exchange.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpacePortal, createPortalProfile, doorPortalProfile, portalClosing, portalOpening, wormholePortalProfile }
  from '../src/portal/space-portal.js';
import { PortalView } from '../src/portal/portal-view.js';
import { LiteCloudPass } from '../src/cloud/lite-cloud-pass.js';

let failures = 0;
const test = (name, work) => {
  try { work(); console.log(`✓ ${name}`); }
  catch (error) { failures++; console.log(`✗ ${name}\n  ${error.stack}`); }
};

function portal() {
  const p = new SpacePortal({ halfWidth: 500, halfHeight: 400 });
  p.setFrames(new THREE.Vector3(10, 20, -1000), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.4, 0.05)),
    new THREE.Vector3(7e10, -3e9, 2e11), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.3, 2.1, 0.2)));
  p.phase = 'open';
  p.open = { x: 1, y: 1, tension: 0, flash: 0 };
  return p;
}

test('mapping preserves the pose relative to the opening (position, heading, velocity)', () => {
  const p = portal();
  const camera = new THREE.Vector3(40, -30, 200).applyQuaternion(p.source.quaternion).add(p.source.position);
  const mapped = p.mapPosition(camera);
  const local = mapped.clone().sub(p.target.position).applyQuaternion(p.target.quaternion.clone().invert());
  assert.ok(local.distanceTo(new THREE.Vector3(40, -30, 200)) < 1e-4);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.1, 0.3));
  const back = p.mapQuaternion(q);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  assert.ok(new THREE.Vector3(0, 0, -1).applyQuaternion(back).distanceTo(p.mapDirection(forward)) < 1e-9);
  p.swapSides();
  assert.ok(p.mapPosition(mapped).distanceTo(camera) < 1e-3, 'swapping sides maps back');
});

test('crossing fires only through the opening and only when it is open', () => {
  const p = portal();
  const at = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(p.source.quaternion).add(p.source.position);
  assert.ok(p.crossing(at(0, 0, 5), at(0, 0, -5)) > 0.49);
  assert.equal(p.crossing(at(0, 0, 5), at(0, 0, 4)), -1, 'no plane crossing');
  assert.equal(p.crossing(at(700, 0, 5), at(700, 0, -5)), -1, 'outside the contour');
  p.open = { x: 1, y: 0.5, tension: 0, flash: 0 };
  assert.equal(p.crossing(at(0, 0, 5), at(0, 0, -5)), -1, 'a half-open fold cannot be crossed');
});

test('opening draws a seam, tears it open continuously, and closing heals it', () => {
  let prev = portalOpening(0);
  assert.equal(prev.y, 0);
  for (let i = 1; i <= 400; i++) {
    const cur = portalOpening(i / 400);
    assert.ok(Math.abs(cur.x - prev.x) < 0.05 && Math.abs(cur.y - prev.y) < 0.05, `opening jumps at ${i}`);
    prev = cur;
  }
  const seam = portalOpening(0.3);
  assert.ok(seam.x > 0.9 && seam.y < 0.02, 'the seam spans the width before it opens');
  assert.ok(Math.abs(portalOpening(1).y - 1) < 1e-9);
  const closed = portalClosing(1);
  assert.ok(closed.x === 0 && closed.y === 0);
});

test('profiles are independent and a person-sized door is a profile, not a different system', () => {
  const lane = createPortalProfile({ halfWidth: 800 });
  const door = doorPortalProfile();
  assert.equal(lane.halfWidth, 800);
  assert.ok(door.halfWidth < 2 && door.halfHeight > door.halfWidth && door.persistent);
  lane.harmonics[0].amp = 1;
  assert.notEqual(createPortalProfile().harmonics[0].amp, 1, 'defaults are not shared mutable state');
});

test('the far view keeps the production media and drops every display transform', () => {
  const pass = (name) => ({ name, enabled: true });
  const passes = { warp: pass('warp'), foregroundPass: pass('fg'), parkedInteriorPass: null, temporalAA: pass('taa'),
    rift: null, bloom: pass('bloom'), grade: pass('grade'), smaa: pass('smaa'), portalComposite: pass('portal') };
  class OutputPass { constructor() { this.enabled = true; } }
  const output = new OutputPass();
  const media = [pass('render'), pass('atmosphere'), pass('clouds')];
  const pipeline = { ...passes, outputPass: output, composer: { passes: [...media, output], renderToScreen: true }, setSize() {} };
  const view = new PortalView({ mainCamera: new THREE.PerspectiveCamera(), createPipeline: () => pipeline });
  view.ensure();
  for (const key of ['warp', 'foregroundPass', 'temporalAA', 'bloom', 'grade', 'smaa', 'portalComposite']) {
    assert.equal(passes[key].enabled, false, key);
  }
  assert.equal(output.enabled, false);
  assert.ok(media.every((p) => p.enabled));
  assert.equal(pipeline.composer.renderToScreen, false);
});

test('crossing exchanges cloud reconstruction state between the two views', () => {
  const make = (name) => {
    const o = Object.create(LiteCloudPass.prototype);
    Object.assign(o, { name, history: [name + '0', name + '1'], historyIndex: name === 'a' ? 0 : 1, historyValid: true,
      frame: name === 'a' ? 3 : 9, previousCamera: name, previousPlanet: name, previousSun: name, previousLocalToView: name,
      previousDeck: name, settleFrames: 0, subpixelIndex: 0, historyRatio: 2, activePlanet: { bodyId: name } });
    o.setActivePlanet = function (planet) { this.activePlanet = planet; };
    return o;
  };
  const a = make('a'), b = make('b');
  const planetA = a.activePlanet, planetB = b.activePlanet;
  a.exchangeTemporalState(b);
  assert.equal(a.history[0], 'b0');assert.equal(a.frame, 9);assert.equal(a.activePlanet, planetB);
  assert.equal(b.history[0], 'a0');assert.equal(b.frame, 3);assert.equal(b.activePlanet, planetA);
});

test('planar lane profile opens from a 0.26 seam in 1.15 s and crosses off-axis cleanly', () => {
  const reach = 2200;
  const p = new SpacePortal(createPortalProfile({
    shape: 'plane',
    openSeconds: 1.15,
    seamFraction: 0.26,
    halfWidth: 0.23 * reach,
    halfHeight: 0.14 * reach,
  }));
  const srcQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.18, -0.52, 0.09, 'YXZ'));
  const dstQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.27, 1.35, -0.14, 'YXZ'));
  p.setFrames(new THREE.Vector3(120, -40, -2200), srcQ, new THREE.Vector3(8e10, -2e9, 4e10), dstQ);
  p.beginOpening();
  // During the seam fraction (u <= 0.26), width draws while height remains a thin seam.
  p.update(0.28, 0.28);
  assert.equal(p.phase, 'opening');
  assert.ok(p.open.x > 0.99 && p.open.y < 0.02, `expected seam at 0.28s, got x=${p.open.x}, y=${p.open.y}`);
  // Finish opening at 1.15s total.
  p.update(0.90, 1.18);
  assert.equal(p.phase, 'open');
  assert.equal(p.open.y, 1);

  const at = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(srcQ).add(p.source.position);
  // Off-axis lateral + oblique trajectory crossing inside the dynamic ellipse.
  const prev = at(180, -85, 24);
  const curr = at(220, -105, -16);
  const t = p.crossing(prev, curr);
  assert.ok(Math.abs(t - 0.6) < 1e-6, `expected exact plane crossing fraction 0.6, got ${t}`);
  // Outside the scaled contour at the same Z span still misses.
  assert.equal(p.crossing(at(700, 0, 24), at(700, 0, -16)), -1, 'off-axis miss outside halfWidth');
  assert.equal(p.crossing(at(0, 450, 24), at(0, 450, -16)), -1, 'off-axis miss outside halfHeight');

  // Off-axis position, heading and velocity map rigidly to target space.
  const mappedCurr = p.mapPosition(curr);
  const localTarget = mappedCurr.clone().sub(p.target.position).applyQuaternion(dstQ.clone().invert());
  assert.ok(localTarget.distanceTo(new THREE.Vector3(220, -105, -16)) < 1e-4);
  const shipQ = srcQ.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12, 0.34, 0.08, 'YXZ')));
  const mappedQ = p.mapQuaternion(shipQ);
  const relLocal = dstQ.clone().invert().multiply(mappedQ);
  const expectedRel = srcQ.clone().invert().multiply(shipQ);
  assert.ok(relLocal.angleTo(expectedRel) < 1e-9);
});

test('the closing portal renders its back world only when the eye can see it', () => {
  const portal = new SpacePortal();
  portal.beginOpening();
  portal.update(3, 3);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 10000);
  const eye = new THREE.Vector3(0, 0, -5);
  assert.equal(portal.needsBackView(eye, camera, false), false);
  camera.rotateY(Math.PI);
  assert.equal(portal.needsBackView(eye, camera, false), true);
  camera.rotateY(-Math.PI);
  eye.z = 5;
  assert.equal(portal.needsBackView(eye, camera, true), false);
  eye.x = portal.halfWidth;
  assert.equal(portal.needsBackView(eye, camera, true), true);
});

test('a wormhole mouth is entered at its near surface and left through the far one', () => {
  const p = new SpacePortal(wormholePortalProfile({ radius: 400 }));
  p.setFrames(new THREE.Vector3(0, 0, -2000), new THREE.Quaternion(), new THREE.Vector3(9e9, 0, 0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.1));
  p.phase = 'open';
  p.open = { x: 1, y: 1, tension: 0, flash: 0 };
  assert.ok(p.crossing(new THREE.Vector3(0, 0, -1500), new THREE.Vector3(0, 0, -1700)) >= 0, 'entering the ball');
  assert.equal(p.crossing(new THREE.Vector3(0, 0, -1500), new THREE.Vector3(0, 0, -1550)), -1, 'still outside');
  assert.equal(p.crossing(new THREE.Vector3(900, 0, -1500), new THREE.Vector3(900, 0, -2500)), -1, 'passing beside it');
  const entry = new THREE.Vector3(0, 0, -1600); // near surface (local z = +400)
  const exit = p.mapPosition(entry);
  const local = exit.clone().sub(p.target.position).applyQuaternion(p.target.quaternion.clone().invert());
  assert.ok(Math.abs(local.z + 400) < 1e-6, 'leaves through the far surface, already past the mouth');
  const located = p.locate(new THREE.Vector3(0, 0, -1000));
  assert.ok(Math.abs(located.z - 600) < 1e-6, 'sphere distance is to the surface');
});

if (failures) {
  console.error(`${failures} portal contract(s) failed`);
  process.exit(1);
}
console.log('PASS: space-fold portal contracts');
