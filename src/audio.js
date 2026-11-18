// Procedural ship and traversal audio. Every sound is synthesized at runtime:
// no downloaded samples, no copyright/licensing dependency, and engine tone can
// follow actual simulation state continuously.

import { makeRng } from './rng.js';
import { SaltlineSfx } from './saltline/sfx.js';
import { SkydiveAudio } from './skydive-audio.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Deterministic brown-noise source: same seed yields the same buffer on every
// load, keeping audio reproducible alongside the rest of the universe.
const _noiseRng = makeRng('audio:noise:v1');

export class FlightAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.paused = false;
    this.wasBoosting = false;
    this.wasWarping = false;
    this.lastCue = null;
    this.lastState = null;
    this.lastAtmosphere = 0;
    this.lastWater = 0;
    this.started = false;
    this.pendingCues = [];
    this.disposed = false;
  }

  async unlock() {
    if (this.disposed) return;
    if (!this.ctx) this.build();
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { return; }
    }
    this.ready = this.ctx.state === 'running';
    if (this.ready && !this.started) {
      this.started = true;
      this.cue('start');
    }
    if (this.ready && this.pendingCues.length) {
      const queued = this.pendingCues.splice(0, 4);
      for (const kind of queued) this.cue(kind);
    }
  }

  build() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.34;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 16;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.006;
    this.compressor.release.value = 0.18;
    this.master.connect(this.compressor).connect(ctx.destination);

    // Saltline's synthesized foley (weapon, rain, thunder) on its own bus.
    this.sfx = new SaltlineSfx();
    this.sfx.attach(ctx, this.master, 1.15);
    this.sfx.prewarm(['rifle_shot', 'rifle_tail_out', 'rifle_dry', 'reload_magout', 'reload_magin',
      'reload_bolt', 'shell_bounce', 'rain', 'thunder']);

    // Menu foley bypasses the master so it still plays while the game (and
    // therefore the master gain) is paused.
    this.uiSfx = new SaltlineSfx();
    this.uiSfx.attach(ctx, this.compressor, 0.55);
    this.uiSfx.prewarm(['ui_hover', 'ui_click']);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0;
    this.engineBus.connect(this.master);

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 520;
    this.engineFilter.Q.value = 0.9;
    this.engineFilter.connect(this.engineBus);

    this.engine = ctx.createOscillator();
    this.engine.type = 'sawtooth';
    this.engine.frequency.value = 42;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.16;
    this.engine.connect(this.engineGain).connect(this.engineFilter);
    this.engine.start();

    this.sub = ctx.createOscillator();
    this.sub.type = 'triangle';
    this.sub.frequency.value = 21;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.4;
    this.sub.connect(this.subGain).connect(this.engineFilter);
    this.sub.start();

    this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      brown = brown * 0.985 + (_noiseRng() * 2 - 1) * 0.15;
      data[i] = Math.max(-1, Math.min(1, brown * 1.8));
    }

    this.airNoise = ctx.createBufferSource();
    this.airNoise.buffer = this.noiseBuffer;
    this.airNoise.loop = true;
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.frequency.value = 900;
    this.airFilter.Q.value = 0.7;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    this.airNoise.connect(this.airFilter).connect(this.airGain).connect(this.master);
    this.airNoise.start();

    this.waterNoise = ctx.createBufferSource();
    this.waterNoise.buffer = this.noiseBuffer;
    this.waterNoise.loop = true;
    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = 'bandpass';
    this.waterFilter.frequency.value = 980;
    this.waterFilter.Q.value = 0.55;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    this.waterNoise.connect(this.waterFilter).connect(this.waterGain).connect(this.master);
    this.waterNoise.start();

    this.warpNoise = ctx.createBufferSource();
    this.warpNoise.buffer = this.noiseBuffer;
    this.warpNoise.loop = true;
    this.warpFilter = ctx.createBiquadFilter();
    this.warpFilter.type = 'bandpass';
    this.warpFilter.frequency.value = 1900;
    this.warpFilter.Q.value = 0.42;
    this.warpGain = ctx.createGain();
    this.warpGain.gain.value = 0;
    this.warpNoise.connect(this.warpFilter).connect(this.warpGain).connect(this.master);
    this.warpNoise.start();

    this.warpTone = ctx.createOscillator();
    this.warpTone.type = 'sine';
    this.warpTone.frequency.value = 58;
    this.warpToneGain = ctx.createGain();
    this.warpToneGain.gain.value = 0;
    this.warpTone.connect(this.warpToneGain).connect(this.master);
    this.warpTone.start();

    // Held pulse charge: a rising, slightly beating hum plus filtered air.
    this.chargeGain = ctx.createGain();
    this.chargeGain.gain.value = 0;
    this.chargeFilter = ctx.createBiquadFilter();
    this.chargeFilter.type = 'lowpass';
    this.chargeFilter.frequency.value = 400;
    this.chargeFilter.connect(this.chargeGain).connect(this.master);
    this.chargeOsc = ctx.createOscillator();
    this.chargeOsc.type = 'sawtooth';
    this.chargeOsc.frequency.value = 46;
    this.chargeOsc.connect(this.chargeFilter);
    this.chargeOsc.start();
    this.chargeBeat = ctx.createOscillator();
    this.chargeBeat.type = 'sine';
    this.chargeBeat.frequency.value = 93;
    this.chargeBeat.connect(this.chargeFilter);
    this.chargeBeat.start();
    this.chargeLevel = -1;

    // A spatial rift has its own resonant bed rather than borrowing the warp
    // whoosh. Three restrained layers make it feel like a large energized
    // volume; cue transients below provide the tear and the final seal.
    this.riftBus = ctx.createGain();
    this.riftBus.gain.value = 0;
    this.riftFilter = ctx.createBiquadFilter();
    this.riftFilter.type = 'lowpass';
    this.riftFilter.frequency.value = 680;
    this.riftFilter.Q.value = 1.4;
    this.riftFilter.connect(this.riftBus).connect(this.master);

    this.riftLow = ctx.createOscillator();
    this.riftLow.type = 'sine';
    this.riftLow.frequency.value = 34;
    this.riftLowGain = ctx.createGain();
    this.riftLowGain.gain.value = 0.58;
    this.riftLow.connect(this.riftLowGain).connect(this.riftFilter);
    this.riftLow.start();

    this.riftHarmonic = ctx.createOscillator();
    this.riftHarmonic.type = 'triangle';
    this.riftHarmonic.frequency.value = 69;
    this.riftHarmonicGain = ctx.createGain();
    this.riftHarmonicGain.gain.value = 0.12;
    this.riftHarmonic.connect(this.riftHarmonicGain).connect(this.riftFilter);
    this.riftHarmonic.start();

    this.riftNoise = ctx.createBufferSource();
    this.riftNoise.buffer = this.noiseBuffer;
    this.riftNoise.loop = true;
    this.riftNoiseFilter = ctx.createBiquadFilter();
    this.riftNoiseFilter.type = 'bandpass';
    this.riftNoiseFilter.frequency.value = 740;
    this.riftNoiseFilter.Q.value = 1.8;
    this.riftNoiseGain = ctx.createGain();
    this.riftNoiseGain.gain.value = 0.14;
    this.riftNoise.connect(this.riftNoiseFilter).connect(this.riftNoiseGain).connect(this.riftFilter);
    this.riftNoise.start();
  }

  tone({ from = 80, to = from, duration = 0.5, gain = 0.12,
    type = 'triangle', lowpass = 1800, delay = 0 }) {
    if (this.disposed) return;
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, from), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), now + duration);
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(gain, now + Math.min(0.06, duration * 0.18));
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(filter).connect(amp).connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  noiseBurst({ duration = 0.5, gain = 0.1, from = 500, to = 1600, q = 0.7, delay = 0 }) {
    if (this.disposed) return;
    if (!this.ready || !this.ctx || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    src.buffer = this.noiseBuffer;
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, now);
    filter.frequency.exponentialRampToValueAtTime(to, now + duration);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(gain, now + Math.min(0.08, duration * 0.2));
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.connect(filter).connect(amp).connect(this.master);
    src.start(now);
    src.stop(now + duration + 0.03);
  }

  // Held pulse: k in 0..1 while charging, -1 when released or cancelled.
  pulseCharge(k) {
    if (this.disposed || !this.ready || !this.ctx || !this.chargeGain) return;
    const now = this.ctx.currentTime;
    if (k < 0) {
      this.chargeGain.gain.setTargetAtTime(0, now, 0.04);
      this.chargeLevel = -1;
      return;
    }
    const level = Math.max(0, Math.min(1, k));
    this.chargeGain.gain.setTargetAtTime(this.paused ? 0 : 0.035 + 0.11 * level, now, 0.06);
    this.chargeOsc.frequency.setTargetAtTime(46 + 70 * level, now, 0.08);
    this.chargeBeat.frequency.setTargetAtTime(93 + 147 * level + 2.5, now, 0.08);
    this.chargeFilter.frequency.setTargetAtTime(380 + 2600 * level * level, now, 0.08);
    this.chargeLevel = level;
  }

  cue(kind, options = {}) {
    if (this.disposed) return;
    this.lastCue = kind;
    if (!this.ready || !this.ctx) {
      if (kind !== 'start' && this.pendingCues.length < 4) this.pendingCues.push(kind);
      return;
    }
    if (this.paused) return;
    if (kind === 'start') {
      this.tone({ from: 92, to: 146, duration: 0.55, gain: 0.13, lowpass: 1100 });
      this.tone({ from: 184, to: 292, duration: 0.72, gain: 0.075, delay: 0.1, lowpass: 1700 });
    } else if (kind === 'boost') {
      this.noiseBurst({ duration: 0.72, gain: 0.19, from: 360, to: 2300, q: 0.5 });
      this.tone({ from: 48, to: 118, duration: 0.62, gain: 0.2, type: 'sawtooth', lowpass: 1500 });
    } else if (kind === 'pulse') {
      // inhale -> low thump on the fold -> airy release; a charged fold is
      // deeper, louder and longer
      const p = Math.max(1, options.power || 1), k = p - 1;
      this.noiseBurst({ duration: 0.2, gain: 0.07, from: 2600, to: 420, q: 0.8 });
      this.tone({ from: 140, to: 62, duration: 0.2, gain: 0.07, type: 'triangle', lowpass: 700 });
      this.tone({ from: 74 - k * 30, to: 31 - k * 10, duration: 0.55 + k * 0.9, gain: 0.26 + k * 0.12, type: 'sine', lowpass: 180, delay: 0.2 });
      this.noiseBurst({ duration: 0.75 + k * 1.1, gain: 0.12 + k * 0.08, from: 380, to: 3600 + k * 2000, q: 0.45, delay: 0.22 });
      this.tone({ from: 260, to: 520, duration: 0.6, gain: 0.03, type: 'sine', lowpass: 1600, delay: 0.28 });
    } else if (kind === 'warp-spool') {
      // reactor spool over the 3 s spool phase
      this.tone({ from: 38, to: 96, duration: 3.1, gain: 0.16, type: 'sawtooth', lowpass: 900 });
      this.tone({ from: 120, to: 610, duration: 3.0, gain: 0.05, type: 'triangle', lowpass: 2600, delay: 0.2 });
      this.noiseBurst({ duration: 3.1, gain: 0.08, from: 260, to: 2400, q: 0.6 });
    } else if (kind === 'warp-enter') {
      // the streak field closes into the tunnel: rising rush, then the punch
      this.noiseBurst({ duration: 0.5, gain: 0.16, from: 900, to: 6200, q: 0.4 });
      this.tone({ from: 62, to: 24, duration: 1.4, gain: 0.32, type: 'sine', lowpass: 160, delay: 0.38 });
      this.noiseBurst({ duration: 1.6, gain: 0.14, from: 5200, to: 700, q: 0.5, delay: 0.4 });
      this.tone({ from: 220, to: 110, duration: 1.2, gain: 0.05, type: 'triangle', lowpass: 1200, delay: 0.42 });
    } else if (kind === 'warp-exit') {
      // the end light opens: reverse rush and a settling low tone
      this.noiseBurst({ duration: 1.1, gain: 0.12, from: 700, to: 5600, q: 0.5 });
      this.noiseBurst({ duration: 2.2, gain: 0.1, from: 4200, to: 260, q: 0.55, delay: 0.9 });
      this.tone({ from: 46, to: 33, duration: 2.6, gain: 0.16, type: 'sine', lowpass: 150, delay: 0.85 });
    } else if (kind === 'rift-open') {
      this.noiseBurst({ duration: 0.085, gain: 0.13, from: 6200, to: 1800, q: 1.2 });
      this.tone({ from: 39, to: 73, duration: 0.64, gain: 0.16, type: 'sine', lowpass: 190 });
      this.tone({ from: 260, to: 620, duration: 0.38, gain: 0.035, type: 'triangle', lowpass: 1800 });
    } else if (kind === 'rift-tear') {
      this.noiseBurst({ duration: 0.16, gain: 0.15, from: 5700, to: 780, q: 1.15 });
      this.noiseBurst({ duration: 0.065, gain: 0.10, from: 7600, to: 2100, q: 0.9, delay: 0.065 });
      this.tone({ from: 84, to: 40, duration: 0.42, gain: 0.15, type: 'sine', lowpass: 220 });
    } else if (kind === 'rift-close') {
      this.noiseBurst({ duration: 0.12, gain: 0.15, from: 3700, to: 190, q: 0.70 });
      this.tone({ from: 88, to: 34, duration: 0.27, gain: 0.22, type: 'sine', lowpass: 180 });
      this.noiseBurst({ duration: 0.19, gain: 0.06, from: 1600, to: 320, q: 0.6, delay: 0.09 });
    } else if (kind === 'atmosphere') {
      this.noiseBurst({ duration: 1.25, gain: 0.17, from: 3600, to: 720, q: 0.58 });
      this.tone({ from: 118, to: 64, duration: 0.9, gain: 0.08, lowpass: 900 });
    } else if (kind === 'landing') {
      this.tone({ from: 148, to: 72, duration: 0.72, gain: 0.13, lowpass: 900 });
    } else if (kind === 'touchdown') {
      this.noiseBurst({ duration: 0.32, gain: 0.16, from: 190, to: 85, q: 1.3 });
      this.tone({ from: 58, to: 38, duration: 0.4, gain: 0.2, lowpass: 260 });
    } else if (kind === 'board') {
      this.tone({ from: 220, to: 330, duration: 0.25, gain: 0.1, lowpass: 1200 });
      this.tone({ from: 330, to: 495, duration: 0.34, gain: 0.08, delay: 0.16, lowpass: 1500 });
    } else if (kind === 'takeoff') {
      this.noiseBurst({ duration: 1.0, gain: 0.12, from: 240, to: 1600, q: 0.55 });
      this.tone({ from: 42, to: 98, duration: 1.05, gain: 0.18, type: 'sawtooth', lowpass: 1300 });
    } else if (kind === 'recall') {
      this.tone({ from: 440, to: 660, duration: 0.22, gain: 0.07, lowpass: 1800 });
      this.tone({ from: 660, to: 880, duration: 0.3, gain: 0.08, delay: 0.2, lowpass: 2200 });
    } else if (kind === 'denied') {
      this.tone({ from: 180, to: 118, duration: 0.22, gain: 0.075, lowpass: 700 });
    } else if (kind === 'fire') {
      this.tone({ from: 1160, to: 390, duration: 0.078, gain: 0.065, type: 'sawtooth', lowpass: 3400 });
      this.noiseBurst({ duration: 0.045, gain: 0.026, from: 3600, to: 1300, q: 1.25 });
    } else if (kind === 'water-splash') {
      this.noiseBurst({ duration: 0.32, gain: 0.085, from: 1600, to: 420, q: 0.48 });
    } else if (kind === 'chute-exit') {
      this.tone({ from: 114, to: 51, duration: .13, gain: .15, lowpass: 380 });
      this.noiseBurst({ duration: .09, from: 820, to: 240, gain: .19, q: .72 });
      this.noiseBurst({ duration: .34, from: 550, to: 2400, gain: .26, q: .6 });
      this.noiseBurst({ duration: .16, from: 2200, to: 570, gain: .16, delay: .14 });
    } else if (kind === 'chute-open') {
      this.noiseBurst({ duration: .15, gain: .39, from: 3400, to: 1250, q: .83 });
      this.noiseBurst({ duration: .34, gain: .32, from: 620, to: 3100, q: .68, delay: .10 });
    } else if (kind === 'chute-load') {
      this.noiseBurst({ duration: .17, gain: .57, from: 1350, to: 290, q: .65 });
      this.tone({ from: 108, to: 38, duration: .29, gain: .31, type: 'sine', lowpass: 240 });
      this.noiseBurst({ duration: .51, gain: .31, from: 2600, to: 720, delay: .07 });
      this.noiseBurst({ duration: .12, gain: .16, from: 2200, to: 910, delay: .23 });
    } else if (kind === 'chute-land') {
      this.noiseBurst({ duration: 0.22, gain: 0.11, from: 420, to: 120, q: 1.1 });
      this.tone({ from: 78, to: 40, duration: 0.24, gain: 0.14, lowpass: 240 });
      this.noiseBurst({ duration: .14, from: 670, to: 190, gain: .21, delay: .115 });
      this.noiseBurst({ duration: .65, from: 2300, to: 510, gain: .21, delay: .23 });
    } else if (kind === 'aad-warn') {
      this.tone({ from: 980, to: 980, duration: 0.09, gain: 0.09, type: 'triangle', lowpass: 2600 });
      this.tone({ from: 1240, to: 1240, duration: 0.11, gain: 0.10, type: 'triangle', lowpass: 2800, delay: 0.11 });
    } else if (kind === 'recall-flyin') {
      this.tone({ from: 440, to: 660, duration: 0.18, gain: 0.06, lowpass: 1800 });
      this.noiseBurst({ duration: 2.2, gain: 0.14, from: 220, to: 1650, q: 0.55, delay: 0.18 });
      this.tone({ from: 44, to: 104, duration: 2.1, gain: 0.15, type: 'sawtooth', lowpass: 920, delay: 0.2 });
    }
  }

  // First-person weapon events from SurfaceWeapons (see surface-weapons.js).
  weaponEvent(type, data = {}, weaponDef = null) {
    if (this.disposed || !this.ready || !this.sfx || this.paused) return;
    const jitter = () => 0.97 + Math.random() * 0.06;
    const id = weaponDef?.id || data?.weaponId || 'PAC9';
    if (type === 'weapon:fire') {
      if (id === 'KR7') {
        this.sfx.play('kr7_shot', { pitch: jitter() });
        this.sfx.play('rifle_tail_out', { gain: data.ads > 0.5 ? 0.72 : 0.92, pitch: 0.94 });
        if (Math.random() < 0.55) this.sfx.play('shell_bounce', { delay: 0.42 + Math.random() * 0.25, gain: 0.7, pitch: jitter() });
      } else if (id === 'KR7_VANTAGE') {
        this.sfx.play('suppressed_shot', { pitch: jitter() });
        if (Math.random() < 0.6) this.sfx.play('shell_bounce', { delay: 0.40 + Math.random() * 0.22, gain: 0.62, pitch: jitter() });
      } else if (id === 'VESPER9') {
        this.sfx.play('vesper_shot', { pitch: jitter() });
        if (Math.random() < 0.45) this.sfx.play('shell_bounce', { delay: 0.38 + Math.random() * 0.22, gain: 0.58, pitch: 1.08 * jitter() });
      } else if (id === 'M12') {
        this.sfx.play('shotgun_shot', { pitch: jitter() });
        this.sfx.play('rifle_tail_out', { gain: 1.0, pitch: 0.74 });
      } else if (id === 'STRIX9') {
        this.sfx.play('pistol_shot', { pitch: jitter() });
        this.sfx.play('rifle_tail_out', { gain: 0.48, pitch: 1.15 });
        if (Math.random() < 0.55) this.sfx.play('shell_bounce', { delay: 0.36 + Math.random() * 0.2, gain: 0.55, pitch: 1.12 * jitter() });
      } else {
        this.sfx.play('rifle_shot', { pitch: jitter() });
        this.sfx.play('rifle_tail_out', { gain: data.ads > 0.5 ? 0.8 : 1 });
        if (Math.random() < 0.55) this.sfx.play('shell_bounce', { delay: 0.42 + Math.random() * 0.25, gain: 0.7, pitch: jitter() });
      }
    } else if (type === 'weapon:pump') {
      if (data.phase === 'back') this.sfx.play('shotgun_pump_back', { pitch: jitter() });
      else if (data.phase === 'fwd') this.sfx.play('shotgun_pump_fwd', { pitch: jitter() });
    } else if (type === 'weapon:dry') {
      this.sfx.play('rifle_dry');
    } else if (type === 'weapon:reload') {
      if (data.phase === 'shell') this.sfx.play('shotgun_shell', { pitch: jitter() });
      else if (data.phase === 'magout') this.sfx.play('reload_magout', { pitch: id === 'STRIX9' ? 1.15 : 1.0 });
      else if (data.phase === 'magin') this.sfx.play('reload_magin', { pitch: id === 'STRIX9' ? 1.12 : 1.0 });
      else if (data.phase === 'bolt') {
        this.sfx.play(id === 'STRIX9' ? 'pistol_slide' : 'reload_bolt', { pitch: jitter() });
      }
    } else if (type === 'weapon:draw') {
      if (data.phase === 'start') {
        this.noiseBurst({ duration: 0.22, gain: 0.032, from: 620, to: 1850, q: 0.9 });
        this.tone({ from: 135, to: 195, duration: 0.14, gain: 0.025, lowpass: 520 });
      } else if (data.phase === 'rack') {
        if (id === 'STRIX9') this.sfx.play('pistol_slide', { gain: 0.85, pitch: 1.04 });
        else if (id === 'M12') this.sfx.play('shotgun_pump_fwd', { gain: 0.85 });
        else this.sfx.play('reload_bolt', { gain: 0.85, pitch: 1.06 });
      }
    } else if (type === 'weapon:holster' && data.phase === 'start') {
      this.noiseBurst({ duration: 0.24, gain: 0.036, from: 1650, to: 480, q: 0.85 });
      this.tone({ from: 190, to: 82, duration: 0.16, gain: 0.042, lowpass: 440, delay: 0.14 });
    }
  }

  cabinStep() {
    if (this.disposed || !this.ready || !this.sfx || this.paused) return;
    this.sfx.play('step_metal', { gain: 0.26, pitch: 0.96 + Math.random() * 0.08 });
  }

  // Surface weather beds: rain intensity 0..1, and a thunder clap when the
  // storm flashes (delayed by distance like real thunder).
  weather({ rain = 0, lightning = 0 } = {}) {
    if (this.disposed || !this.ready || !this.sfx) return;
    this.sfx.loop('rain', this.paused ? 0 : Math.min(1, rain) * 0.85, 0.8);
    if (lightning > 0.5 && !this.lightningLatched) {
      this.lightningLatched = true;
      this.sfx.play('thunder', { delay: 0.6 + Math.random() * 2.4, gain: 0.5 + lightning * 0.4 });
    } else if (lightning < 0.1) this.lightningLatched = false;
  }

  update({ state, speed, atmosphere, boosting, warp, rift = 0, water = 0, underwater = false,
    canopy = 0, cloud = 0, brake = 0, paused }) {
    if (this.disposed) return;
    if (!this.ready || !this.ctx) return;
    const now = this.ctx.currentTime;
    const set = (param, value, tau = 0.08) => param.setTargetAtTime(value, now, tau);
    const flight = state === 'space' || state === 'flyto' || state === 'takeoff'
      || state === 'landing' || state === 'boarding';
    const speedK = clamp01(Math.log10(1 + Math.max(0, speed)) / 6.2);
    const boostK = boosting && state === 'space' ? 1 : 0;
    const warpK = clamp01(warp);
    const riftK = clamp01(rift);
    const active = paused ? 0 : 1;

    const jumping = state === 'skydive';
    if (jumping) {
      this.jumpWind ??= new SkydiveAudio(this.ctx, this.master);
      this.jumpWind.update(speed, canopy, cloud, brake, paused);
    } else this.jumpWind?.release();
    set(this.master.gain, active * 0.34, 0.05);
    set(this.engineBus.gain, active * (flight ? 0.23 + speedK * 0.34 + boostK * 0.2 : jumping ? 0 : 0.018), 0.1);
    set(this.engine.frequency, 38 + speedK * 92 + boostK * 42, 0.06);
    set(this.sub.frequency, 19 + speedK * 40 + boostK * 15, 0.08);
    set(this.engineFilter.frequency, 390 + speedK * 1750 + boostK * 1350, 0.07);
    set(this.airGain.gain, jumping ? 0 : active * atmosphere * (0.02 + speedK * 0.25 + boostK * 0.12), 0.1);
    set(this.airFilter.frequency, 480 + speedK * 3200 + boostK * 1200, 0.08);
    set(this.warpGain.gain, active * warpK * 0.26, 0.05);
    set(this.warpFilter.frequency, 900 + warpK * 4800, 0.05);
    set(this.warpToneGain.gain, active * warpK * 0.12, 0.07);
    set(this.warpTone.frequency, 50 + warpK * 155, 0.05);
    set(this.riftBus.gain, active * riftK * 0.15, riftK > 0 ? 0.16 : 0.055);
    set(this.riftFilter.frequency, 430 + riftK * 760, 0.12);
    set(this.riftLow.frequency, 31 + riftK * 8, 0.16);
    set(this.riftHarmonic.frequency, 65 + riftK * 15, 0.13);
    set(this.riftNoiseFilter.frequency, 520 + riftK * 1250, 0.11);
    const waterK = clamp01(water);
    set(this.waterGain.gain, active * waterK * (state === 'walk' ? 0.12 : 0.22), 0.09);
    set(this.waterFilter.frequency, underwater ? 260 : 680 + waterK * 1700, 0.1);
    set(this.engineFilter.frequency, underwater ? 240 : 390 + speedK * 1750 + boostK * 1350, 0.07);

    if (this.lastState !== null && state !== this.lastState) {
      if (state === 'landing') this.cue('landing');
      else if (state === 'walk' && this.lastState === 'landing') this.cue('touchdown');
      else if (state === 'takeoff') this.cue('takeoff');
    }
    if (atmosphere > 0.18 && this.lastAtmosphere <= 0.18 && speed > 180) this.cue('atmosphere');
    if (boostK && !this.wasBoosting) this.cue('boost');
    // Pulse and warp transients are cued explicitly by the transit timeline
    // ('pulse', 'warp-spool', 'warp-enter', 'warp-exit'); the bed above only
    // follows its intensity.
    if (waterK > 0.18 && this.lastWater <= 0.18) this.cue('water-splash');
    this.lastState = state;
    this.lastAtmosphere = atmosphere;
    this.lastWater = waterK;
    this.wasBoosting = !!boostK;
    this.wasWarping = warpK > 0.08;
  }

  playUi(name) {
    if (this.disposed || !this.ctx || !this.uiSfx || this.ctx.state === 'suspended') return;
    this.uiSfx.play(name);
  }

  setPaused(paused) {
    if (this.disposed) return;
    this.paused = paused;
    if (!this.ready || !this.ctx) return;
    this.master.gain.setTargetAtTime(paused ? 0 : 0.34, this.ctx.currentTime, 0.04);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.started = false;
    this.pendingCues.length = 0;
    const stop = (node) => {
      if (!node) return;
      try { node.stop(); } catch { /* already stopped or never started */ }
    };
    stop(this.engine);
    stop(this.sub);
    stop(this.warpTone);
    stop(this.chargeOsc);
    stop(this.chargeBeat);
    stop(this.riftLow);
    stop(this.riftHarmonic);
    stop(this.airNoise);
    stop(this.warpNoise);
    stop(this.riftNoise);
    stop(this.waterNoise);
    this.jumpWind?.release();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') {
      try { ctx.close(); } catch { /* context already closing */ }
    }
  }
}
