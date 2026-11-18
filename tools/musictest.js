import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackgroundMusic, TRACK_DEFS, createDirectorMemory, pickTrack } from '../src/music.js';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const AUDIO_DIR = join(ROOT, 'assets', 'audio');

// 1. Asset contract: 1-to-1 bijection between TRACK_DEFS and assets/audio/*.mp3
const diskFiles = (await readdir(AUDIO_DIR)).filter((f) => f.endsWith('.mp3')).sort();
const defFiles = TRACK_DEFS.map((t) => t.file).sort();
assert.equal(TRACK_DEFS.length, 42, `Expected 42 tracks in TRACK_DEFS, got ${TRACK_DEFS.length}`);
assert.deepEqual(defFiles, diskFiles, 'TRACK_DEFS files must match assets/audio/*.mp3 1-to-1');

const seenIds = new Set();
for (const def of TRACK_DEFS) {
  assert.ok(!seenIds.has(def.id), `Duplicate track id: ${def.id}`);
  seenIds.add(def.id);
  const info = await stat(join(AUDIO_DIR, def.file));
  assert.ok(info.size > 400_000, `Audio file unexpectedly small: ${def.file} (${info.size} B)`);
}

// 2. Scene priority & hysteresis contract in pickTrack
const mem = createDirectorMemory();

assert.equal(pickTrack({ state: 'space', heroActive: true }, mem), 'hero-theme');
assert.equal(pickTrack({ state: 'space', starmapOpen: true }, mem), 'pool:starmap');
assert.equal(pickTrack({ state: 'space', routeChoiceOpen: true }, mem), 'pool:starmap');
assert.equal(pickTrack({ state: 'space', riftActive: true }, mem), 'pool:rift');
assert.equal(pickTrack({ state: 'warp' }, mem), 'interstellar-flight');
assert.equal(pickTrack({ state: 'skydive' }, mem), 'halo-skydive');
assert.equal(pickTrack({ state: 'walk', planetType: 'ocean', underwater: true }, mem), 'abyssal-dive');
assert.equal(pickTrack({ state: 'walk', planetType: 'ocean', dayFactor: 0.8 }, mem), 'pool:planet:ocean');
assert.equal(pickTrack({ state: 'walk', planetType: 'artificialHabitat' }, mem), 'floating-city');

// Planetary continuity across landing -> landed -> shipwalk -> walk
assert.equal(pickTrack({ state: 'landing', planetType: 'lava' }, mem), 'pool:planet:lava');
assert.equal(pickTrack({ state: 'landed', shipLanded: true, planetType: 'ice' }, mem), 'pool:planet:ice');
assert.equal(pickTrack({ state: 'shipwalk', shipLanded: true, planetType: 'desert' }, mem), 'pool:planet:desert');
// High-altitude orbital skydive hover (shipLanded=false) stays in cruise until jumping
assert.equal(pickTrack({ state: 'shipwalk', shipLanded: false, planetType: 'lush' }, mem), 'pool:cruise');

// Civilization landmarks: hero-city-world, surface outpost, orbital station
assert.equal(
  pickTrack({
    state: 'space',
    planetType: 'lush',
    civilizationSiteType: 'hero-city-world',
    civilizationDistance: 14000,
  }, mem),
  'pool:metropolis',
);
assert.equal(
  pickTrack({
    state: 'walk',
    planetType: 'barren',
    civilizationSiteType: 'research-outpost',
    civilizationDistance: 120,
  }, mem),
  'frontier-metropolis',
);
assert.equal(
  pickTrack({ state: 'space', nearOrbitalStation: true }, mem),
  'frontier-metropolis',
);

// Habitable day/night & alpine snow hysteresis
const bioMem = createDirectorMemory();
assert.equal(pickTrack({ state: 'walk', planetType: 'lush', planetKey: 'p1', dayFactor: 0.7, snowWeight: 0.1 }, bioMem), 'pool:planet:lush');
assert.equal(pickTrack({ state: 'walk', planetType: 'lush', planetKey: 'p1', dayFactor: 0.24, snowWeight: 0.1 }, bioMem), 'pool:planet:lush');
assert.equal(pickTrack({ state: 'walk', planetType: 'lush', planetKey: 'p1', dayFactor: 0.20, snowWeight: 0.1 }, bioMem), 'lush-night');
// Stays in night inside deadband (0.22..0.30)
assert.equal(pickTrack({ state: 'walk', planetType: 'lush', planetKey: 'p1', dayFactor: 0.27, snowWeight: 0.1 }, bioMem), 'lush-night');
assert.equal(pickTrack({ state: 'walk', planetType: 'lush', planetKey: 'p1', dayFactor: 0.32, snowWeight: 0.1 }, bioMem), 'pool:planet:lush');
// Alpine snow hysteresis (0.25..0.35) overrides night
assert.equal(pickTrack({ state: 'walk', planetType: 'lush', planetKey: 'p1', dayFactor: 0.15, snowWeight: 0.36 }, bioMem), 'pool:alpine');
assert.equal(pickTrack({ state: 'walk', planetType: 'lush', planetKey: 'p1', dayFactor: 0.15, snowWeight: 0.28 }, bioMem), 'pool:alpine');
assert.equal(pickTrack({ state: 'walk', planetType: 'lush', planetKey: 'p1', dayFactor: 0.15, snowWeight: 0.22 }, bioMem), 'lush-night');

// Surface combat + 5 s cooldown linger (per-frame dt is clamped to 0.5 s)
const combatMem = createDirectorMemory();
assert.equal(pickTrack({ dt: 0.1, state: 'walk', planetType: 'barren', surfaceCombat: true }, combatMem), 'surface-combat');
for (let i = 0; i < 10; i++) {
  assert.equal(pickTrack({ dt: 0.45, state: 'walk', planetType: 'barren', surfaceCombat: false }, combatMem), 'surface-combat');
}
// 10 * 0.45 = 4.5 s elapsed (< 5.0 s); two more 0.45 s steps cross 5.0 s
pickTrack({ dt: 0.45, state: 'walk', planetType: 'barren', surfaceCombat: false }, combatMem);
assert.equal(pickTrack({ dt: 0.45, state: 'walk', planetType: 'barren', surfaceCombat: false }, combatMem), 'pool:planet:barren');

// Black-hole & gas-giant hysteresis
const hazardMem = createDirectorMemory();
assert.equal(pickTrack({ state: 'space', blackHoleRatio: 6.8 }, hazardMem), 'pool:blackhole');
assert.equal(pickTrack({ state: 'space', blackHoleRatio: 7.6 }, hazardMem), 'pool:blackhole');
assert.equal(pickTrack({ state: 'space', blackHoleRatio: 8.5 }, hazardMem), 'pool:cruise');
assert.equal(pickTrack({ state: 'space', gasGiantAltRatio: 0.52 }, hazardMem), 'gas-giant-dive');
assert.equal(pickTrack({ state: 'space', gasGiantAltRatio: 0.66 }, hazardMem), 'gas-giant-dive');
assert.equal(pickTrack({ state: 'space', gasGiantAltRatio: 0.78 }, hazardMem), 'pool:cruise');

// 3. BackgroundMusic WebAudio graph, lazy loading, pool rotation & cabin muffle
const prevAudio = globalThis.Audio;
class FakeAudioElement {
  constructor() {
    this.preload = '';
    this.loop = false;
    this.src = '';
    this.currentTime = 0;
    this.paused = true;
    this.listeners = new Map();
  }
  load() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type) {
    this.listeners.delete(type);
  }
  emitEnded() {
    this.listeners.get('ended')?.();
  }
}

function makeFakeAudioContext() {
  const makeParam = (initial) => ({
    value: initial,
    cancelScheduledValues() {},
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    exponentialRampToValueAtTime(v) { this.value = v; },
  });
  return {
    currentTime: 10,
    destination: {},
    createGain() {
      return {
        gain: makeParam(1),
        connect(target) { return target; },
        disconnect() {},
      };
    },
    createBiquadFilter() {
      return {
        type: 'lowpass',
        frequency: makeParam(20000),
        Q: makeParam(1),
        connect(target) { return target; },
        disconnect() {},
      };
    },
    createMediaElementSource() {
      return {
        connect(target) { return target; },
        disconnect() {},
      };
    },
  };
}

globalThis.Audio = FakeAudioElement;
try {
  let seed = 17;
  const detRandom = () => {
    seed = (seed * 48271) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const bgm = new BackgroundMusic({ random: detRandom });
  bgm.attach(makeFakeAudioContext());

  // Zero eager downloads at attach time
  for (const rec of bgm.tracks.values()) {
    assert.equal(rec.src || rec.el.src, '', 'No audio element should fetch before first cue');
  }

  // Multi-track cruise pool advances without immediate repeat on track end
  bgm.update({ state: 'space' });
  const playedCruise = [bgm.current];
  assert.equal(bgm.currentPool, 'cruise');
  assert.equal(bgm.tracks.get(bgm.current).el.loop, false);
  for (let i = 0; i < 8; i++) {
    const prev = bgm.current;
    bgm.tracks.get(prev).el.emitEnded();
    assert.notEqual(bgm.current, prev, 'Multi-track pool must never repeat the same track back-to-back');
    assert.equal(bgm.currentPool, 'cruise');
    playedCruise.push(bgm.current);
  }
  assert.ok(new Set(playedCruise).size >= 4, 'Cruise pool rotation should cover diverse tracks');

  // Single-track cue on frontier-metropolis loops, then seamlessly promotes to
  // multi-track metropolis pool when approaching hero-city-world
  bgm.update({ state: 'space', nearOrbitalStation: true });
  assert.equal(bgm.current, 'frontier-metropolis');
  assert.equal(bgm.tracks.get('frontier-metropolis').el.loop, true);

  bgm.update({
    state: 'space',
    planetType: 'lush',
    civilizationSiteType: 'hero-city-world',
    civilizationDistance: 12000,
  });
  assert.equal(bgm.current, 'frontier-metropolis', 'Should keep playing frontier-metropolis without restarting');
  assert.equal(bgm.tracks.get('frontier-metropolis').el.loop, false, 'Promoted pool should disable single-track loop');
  bgm.tracks.get('frontier-metropolis').el.emitEnded();
  assert.equal(bgm.current, 'cyber-metropolis-entry', 'Ending frontier-metropolis in metropolis pool rotates to cyber-metropolis-entry');

  // Cabin muffle low-pass filter engages inside grounded closed-ramp cabin and opens outside
  bgm.update({ state: 'landed', shipLanded: true, planetType: 'ice', muffledCabin: true });
  assert.equal(bgm.filter.frequency.value, 1850);
  bgm.update({ state: 'walk', shipLanded: true, planetType: 'ice', muffledCabin: false });
  assert.equal(bgm.filter.frequency.value, 20000);

  bgm.dispose();
} finally {
  globalThis.Audio = prevAudio;
}
