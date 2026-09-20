import assert from 'node:assert/strict';
import { oceanSeconds, oceanClockJumped } from '../src/ocean-clock.js';

assert.equal(oceanSeconds(50), 3000);
assert.equal(oceanClockJumped(null, 3000, 1 / 60), false);
assert.equal(oceanClockJumped(3000, 3000 + 1 / 60, 1 / 60), false);
assert.equal(oceanClockJumped(3000, 3000, 1 / 60), false, 'pause preserves the field');
assert.equal(oceanClockJumped(3000, 2999, 1 / 60), true);
assert.equal(oceanClockJumped(3000, 3001, 1 / 60), true);
assert.equal(oceanClockJumped(3000, 3000.1, 0.08), false, 'normal slow frame is not time travel');
assert.throws(() => oceanSeconds(Infinity), RangeError);
console.log('Ocean clock: normal/paused frames preserve history; time travel invalidates it.');
