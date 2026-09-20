// CPU event-order regression. This deliberately omits compatibility mouse
// button events after canceled pointerdown. It is not a browser/visual gate.
import assert from 'node:assert/strict';
import * as THREE from 'three';

class EventSurface {
  listeners = new Map();
  addEventListener(type, callback, options = false) {
    const list = this.listeners.get(type) || [];
    list.push({ callback, capture: options === true || options.capture === true });
    this.listeners.set(type, list);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item.callback !== callback));
  }
  emit(event, capture) {
    for (const item of this.listeners.get(event.type) || []) {
      if (item.capture === capture) item.callback(event);
    }
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}
const windowSurface = new EventSurface();
const documentSurface = new EventSurface();
const canvas = new EventSurface(), ui = new EventSurface();
globalThis.window = windowSurface;
globalThis.document = documentSurface;
documentSurface.pointerLockElement = null;
documentSurface.querySelector = () => canvas;
canvas.requestPointerLock = () => { documentSurface.pointerLockElement = canvas; };
const dispatch = (type, properties = {}, target = canvas) => {
  const event = { type, target, pointerType: 'mouse', pointerId: 1, button: 2,
    buttons: 2, clientX: 0, clientY: 0, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...properties };
  const path = target === windowSurface ? [windowSurface]
    : target === documentSurface ? [windowSurface, documentSurface]
      : [windowSurface, documentSurface, target];
  for (const item of path) item.emit(event, true);
  for (const item of [...path].reverse()) item.emit(event, false);
  return event;
};
const { ShipView } = await import('../src/ship-view.js');
const { SpaceControls, keys } = await import('../src/controls.js');
const camera = new THREE.PerspectiveCamera();
camera.domElement = canvas;
const nav = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion() };
// Match production construction order: flight's target listener exists before
// ShipView's document capture listener. Event phases, not registration order,
// must establish RMB ownership before SpaceControls consumes the event.
const controls = new SpaceControls(canvas, nav);
const view = new ShipView({ def: { rooms: [], blocks: [] } }, camera);
controls.canSteer = () => !view.rmbLookActive();
controls.canMouseBoost = () => !view.rmbLookActive();
view.viewMode = 'cockpit';
const down = dispatch('pointerdown');
assert.equal(down.defaultPrevented, true, 'real flight handler cancels pointerdown');
assert.equal(documentSurface.pointerLockElement, canvas);
assert.equal(view.rmbLookActive(), true, 'RMB needs no compatibility mousedown');
dispatch('mousemove', { movementX: 100, movementY: 80 }, documentSurface);
assert.equal(view.freeYaw, -0.3);
assert.equal(view.freePitch, -0.24);
assert.deepEqual(controls.steerInput, { x: 0, y: 0 }, 'free-look does not feed hull steering');
controls.update(0.1);
assert.equal(nav.vel.length(), 0, 'RMB free-look does not propel the ship');
assert.equal(nav.quat.angleTo(new THREE.Quaternion()), 0, 'free-look leaves flight attitude untouched');
keys.ShiftLeft = true;
controls.update(0.1);
assert.ok(nav.vel.length() > 0, 'keyboard boost remains available while looking');
keys.ShiftLeft = false;
dispatch('pointerup', { buttons: 0 });
assert.equal(view.rmb, false);

for (const release of ['pointercancel', 'blur', 'pointerlockchange']) {
  documentSurface.pointerLockElement = canvas;
  dispatch('pointerdown');
  if (release === 'pointerlockchange') documentSurface.pointerLockElement = null;
  dispatch(release, {}, release === 'blur' ? windowSurface : documentSurface);
  assert.equal(view.rmb, false, `${release} releases stale free-look`);
}
documentSurface.pointerLockElement = null;
dispatch('pointerdown', {}, ui);
assert.equal(view.rmb, false, 'unlocked UI right-click does not claim flight input');
dispatch('pointerdown', { pointerType: 'touch' });
assert.equal(view.rmb, false, 'touch does not masquerade as RMB');

view.viewMode = 'chase';
nav.vel.set(0, 0, 0);
documentSurface.pointerLockElement = canvas;
dispatch('pointerdown');
assert.equal(view.rmbLookActive(), false, 'chase RMB is not cockpit look');
controls.update(0.1);
assert.ok(nav.vel.length() > 0, 'chase RMB still boosts');
dispatch('pointerup', { buttons: 0 });

view.viewMode = 'cockpit';
view.shipwalk = true;
view.seatT = 0.5;
const before = [view.walkYaw, view.walkPitch, view.freeYaw, view.freePitch];
dispatch('pointerdown');
dispatch('mousemove', { movementX: 70, movementY: 40 }, documentSurface);
assert.deepEqual([view.walkYaw, view.walkPitch, view.freeYaw, view.freePitch], before,
  'seat transition does not consume head-look');
view.seatT = 1;
dispatch('mousemove', { movementX: 70, movementY: 40 }, documentSurface);
assert.ok(view.walkYaw < before[0] && view.walkPitch < before[1], 'standing cabin head-look remains active');
assert.equal(view.freeYaw, before[2], 'standing cabin does not change cockpit free-look');
dispatch('pointerup', { buttons: 0 });
// Browsers cancel a pointer without reporting a released mouse button.
// It must not convert cockpit look into a latched chase-style boost.
view.shipwalk = false;
view.viewMode = 'cockpit';
documentSurface.pointerLockElement = canvas;
dispatch('pointerdown');
dispatch('pointercancel', { button: -1, buttons: 0 });
assert.equal(view.rmb, false);
assert.equal(controls.boosting, false, 'pointer cancellation clears held boost');
assert.equal(controls.pointers.size, 0, 'document cancellation releases the captured gesture');
let taps = 0;
controls.onClick = () => { taps++; };
dispatch('pointerdown', { pointerType: 'touch', button: 0, buttons: 1 });
dispatch('pointercancel', { pointerType: 'touch', button: -1, buttons: 0 });
assert.equal(taps, 0, 'a canceled touch gesture must not select a destination');
assert.equal(controls.firing, false);
controls.dispose();
assert.equal((windowSurface.listeners.get('pointercancel') || []).length, 0,
  'disposing controls removes global cancellation ownership');
console.log('PASS: canceled pointerdown RMB ownership, UI/touch isolation, release paths, chase/keyboard boost, steering and seat head-look. CPU event model only; browser evidence remains required.');
