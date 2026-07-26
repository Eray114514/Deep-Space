import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WaterInteractionField } from '../src/water-interaction.js';

const field = new WaterInteractionField(4);
field.setPlanet('test-water');
const origin = new THREE.Vector3(0, 0, 0);
field.inject(origin, { strength: 1.2, speed: 5, foam: 0.8 });
assert.equal(field.activeCount(), 1);
field.update(0.5);
const crest = field.sample(new THREE.Vector3(3.2, 0, 0));
assert.ok(Math.abs(crest.height) > 0.01, 'propagating wake has height at its fixed crest');
assert.ok(crest.foam >= 0, 'wake foam is finite and non-negative');
field.update(8);
assert.equal(field.activeCount(), 0, 'wake decays instead of remaining as a loop');
field.setPlanet('other-water');
assert.equal(field.activeCount(), 0, 'planet changes clear the local interaction field');
console.log('water interaction propagation and decay tests passed');
