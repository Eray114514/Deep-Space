// Landing scars and downwash records (pure Node): per-planet persistence, the
// scar cap, monotonic fall progress, downwash fade-out and origin-relative
// shader copies.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DISTURBANCE_CAP, DISTURBANCE_GLSL, SCAR_CAP, VegetationDisturbance, disturbanceUniforms }
  from '../src/vegetation/disturbance.js';

const field = new VegetationDisturbance();
const { uDistPos, uDistData } = disturbanceUniforms();
const origin = new THREE.Vector3(1200000, 3, -4);
const copy = (planetId) => field.copyRelative(uDistPos.value, uDistData.value, origin, planetId);

field.setPlanet('a');
const scar = field.addScar(new THREE.Vector3(1200010, 3, -4), 20);
field.setFell(scar, 0.4);
field.setFell(scar, 0.2);
assert.equal(scar.fell, 0.4, 'a fallen tree never stands back up');
field.setFell(scar, 5);
assert.equal(scar.fell, 1);
copy('a');
assert.deepEqual(uDistPos.value[0].toArray(), [10, 0, 0, 20]);
assert.equal(uDistData.value[0].x, 1);
copy('b');
assert.ok(uDistPos.value[0].x > 1e8, 'another planet must not see this scar');

field.setDownwash(new THREE.Vector3(1200000, 3, -4), 30, 0.8);
field.update(0.016);
copy('a');
assert.equal(uDistData.value[DISTURBANCE_CAP - 1].y, 0.8, 'a refreshed downwash holds its strength');
for (let i = 0; i < 120; i++) field.update(0.016);
copy('a');
assert.ok(uDistPos.value[DISTURBANCE_CAP - 1].x > 1e8, 'the downwash fades once the ship is gone');

field.setPlanet('b');
for (let i = 0; i < SCAR_CAP + 3; i++) field.addScar(new THREE.Vector3(i, 0, 0), 20);
assert.equal(field.scars.length, SCAR_CAP, 'only the newest scars are kept');
field.setPlanet('a');
assert.equal(field.scars.length, 1, 'scars survive leaving and returning to a planet');
assert.equal(field.scars[0], scar);
assert.match(DISTURBANCE_GLSL, /float plantPadCrush\(vec3 base, vec3 upW, float r, float innerFrac, float outerFrac\)/,
  'shared disturbance GLSL exposes hull-pad clear helper');
console.log(`PASS: vegetation disturbance (${SCAR_CAP} scars + downwash, per-planet persistence, monotonic fall, fade-out, hull-pad clear).`);
