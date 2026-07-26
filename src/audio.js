// Procedural ship and traversal audio. Every sound is synthesized at runtime:
// no downloaded samples, no copyright/licensing dependency, and engine tone can
// follow actual simulation state continuously.

import { makeRng } from './rng.js';

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

  cue(kind) {
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
    } else if (kind === 'warp') {
      this.noiseBurst({ duration: 1.8, gain: 0.2, from: 620, to: 5200, q: 0.42 });
      this.tone({ from: 54, to: 420, duration: 1.85, gain: 0.2, type: 'sawtooth', lowpass: 3800 });
    } else if (kind === 'rift-open') {
      this.noiseBurst({ duration: 2.45, gain: 0.13, from: 150, to: 3600, q: 0.34 });
      this.tone({ from: 29, to: 47, duration: 2.35, gain: 0.20, type: 'sine', lowpass: 170 });
      this.tone({ from: 71, to: 178, duration: 2.15, gain: 0.075, type: 'triangle', lowpass: 760, delay: 0.08 });
      this.tone({ from: 390, to: 980, duration: 1.52, gain: 0.032, type: 'sine', lowpass: 2400, delay: 0.38 });
      this.noiseBurst({ duration: 0.46, gain: 0.17, from: 4800, to: 820, q: 1.15, delay: 1.88 });
      this.tone({ from: 82, to: 39, duration: 0.52, gain: 0.18, type: 'triangle', lowpass: 260, delay: 1.91 });
    } else if (kind === 'rift-close') {
      this.noiseBurst({ duration: 0.72, gain: 0.15, from: 3100, to: 145, q: 0.62 });
      this.tone({ from: 176, to: 43, duration: 0.74, gain: 0.14, type: 'triangle', lowpass: 820 });
      this.tone({ from: 55, to: 27, duration: 0.36, gain: 0.23, type: 'sine', lowpass: 150, delay: 0.40 });
      this.noiseBurst({ duration: 0.13, gain: 0.19, from: 920, to: 105, q: 1.7, delay: 0.54 });
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
    }
  }

  update({ state, speed, atmosphere, boosting, warp, rift = 0, water = 0, underwater = false, paused }) {
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

    set(this.master.gain, active * 0.34, 0.05);
    set(this.engineBus.gain, active * (flight ? 0.23 + speedK * 0.34 + boostK * 0.2 : 0.018), 0.1);
    set(this.engine.frequency, 38 + speedK * 92 + boostK * 42, 0.06);
    set(this.sub.frequency, 19 + speedK * 40 + boostK * 15, 0.08);
    set(this.engineFilter.frequency, 390 + speedK * 1750 + boostK * 1350, 0.07);
    set(this.airGain.gain, active * atmosphere * (0.02 + speedK * 0.25 + boostK * 0.12), 0.1);
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
    if (warpK > 0.08 && !this.wasWarping) this.cue('warp');
    if (waterK > 0.18 && this.lastWater <= 0.18) this.cue('water-splash');
    this.lastState = state;
    this.lastAtmosphere = atmosphere;
    this.lastWater = waterK;
    this.wasBoosting = !!boostK;
    this.wasWarping = warpK > 0.08;
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
    stop(this.riftLow);
    stop(this.riftHarmonic);
    stop(this.airNoise);
    stop(this.warpNoise);
    stop(this.riftNoise);
    stop(this.waterNoise);
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') {
      try { ctx.close(); } catch { /* context already closing */ }
    }
  }
}
