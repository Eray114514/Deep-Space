// Pure-CPU contracts for the space-fold portal (src/portal/). No GL: geometry,
// choreography, far-view pass ownership and the cloud history exchange.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpacePortal, createPortalProfile, doorPortalProfile, portalClosing, portalOpening }
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

if (failures) {
  console.error(`${failures} portal contract(s) failed`);
  process.exit(1);
}
console.log('PASS: space-fold portal contracts');
