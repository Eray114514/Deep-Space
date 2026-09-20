import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WaterInteractionField } from '../src/water-interaction.js';
import { sampleOceanWakePacket } from '../src/ocean-wake-packet.js';

const field = new WaterInteractionField(4);
field.setPlanet('test-water');
const origin = new THREE.Vector3(0, 0, 0);
field.inject(origin, { strength: 1.2, speed: 5, foam: 0.8 });
assert.equal(field.activeCount(), 1);
field.update(0.5);
const crest = field.sample(new THREE.Vector3(3.2, 0, 0));
assert.ok(Math.abs(crest.height) > 0.01, 'legacy impact probe has an oscillating signal at its fixed crest');
assert.ok(crest.foam >= 0, 'impact probe foam is finite and non-negative');
field.update(8);
assert.equal(field.activeCount(), 0, 'wake decays instead of remaining as a loop');
field.setPlanet('other-water');
assert.equal(field.activeCount(), 0, 'planet changes clear the local interaction field');

const source = new THREE.Vector3(0, 6000000, 0);
const travel = new THREE.Vector3(1, 0, 0);
const wake = new WaterInteractionField(4);
wake.setPlanet('shared-packet');
wake.inject(source, { strength: 1.2, speed: 8.8, foam: 0.8, direction: travel });
const reference = (position, age) => {
  const radial = position.clone().normalize();
  const axis = travel.clone().addScaledVector(radial, -travel.dot(radial)).normalize();
  const side = radial.clone().cross(axis).normalize();
  const delta = position.clone().sub(source);
  const packet = sampleOceanWakePacket({ along: delta.dot(axis), lateral: delta.dot(side),
    age, speed: 8.8, strength: 1.2 });
  return {
    height: Math.sin(packet.armDistance * 2.1 - age * 4.2) * packet.armEnvelope * 0.22,
    foam: (packet.armEnvelope + packet.centerEnvelope * 0.4) * 0.8,
  };
};
let lastAge = 0;
for (const age of [0, 0.7, 1.5, 2.6, 7, 8]) {
  wake.update(age - lastAge);
  for (const [along, lateral] of [[-8, 6], [-25, 14], [0, 0], [-500, 200]]) {
    const position = source.clone().add(new THREE.Vector3(along, 0, -lateral));
    const actual = wake.sample(position), expected = reference(position, age);
    assert.ok(Math.abs(actual.height - expected.height) < 1e-12
      && Math.abs(actual.foam - expected.foam) < 1e-12, 'probe consumes the same packet to arithmetic precision');
  }
  assert.deepEqual(wake.positions[0], source, 'age advances without moving/replacing the source');
  lastAge = age;
}
assert.deepEqual(wake.sample(source), { height: 0, foam: 0 }, 'packet is zero at the 8 s lifetime boundary');
wake.update(0.01);
assert.equal(wake.activeCount(), 0);
const fresh = new WaterInteractionField();
fresh.inject(source, { direction: travel });
assert.deepEqual(fresh.sample(source.clone().add(new THREE.Vector3(-56, 0, 0))),
  { height: 0, foam: 0 }, 'new pressure source does not invent a 56 m old-model trail');
console.log('water interaction propagation and decay tests passed');
