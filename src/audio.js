// Lightweight procedural flight audio. It deliberately uses Web Audio rather
// than downloaded loops so every universe boots immediately and the engine can
// react continuously to speed, atmosphere, boost and warp state.

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class FlightAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.paused = false;
    this.wasBoosting = false;
    this.wasWarping = false;
  }

  async unlock() {
    if (!this.ctx) this.build();
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { return; }
    }
    this.ready = this.ctx.state === 'running';
  }

  build() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.24;
    this.master.connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0;
    this.engineBus.connect(this.master);

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 420;
    this.engineFilter.Q.value = 0.8;
    this.engineFilter.connect(this.engineBus);

    this.engine = ctx.createOscillator();
    this.engine.type = 'sawtooth';
    this.engine.frequency.value = 42;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.18;
    this.engine.connect(this.engineGain).connect(this.engineFilter);
    this.engine.start();

    this.sub = ctx.createOscillator();
    this.sub.type = 'triangle';
    this.sub.frequency.value = 21;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.34;
    this.sub.connect(this.subGain).connect(this.engineFilter);
    this.sub.start();

    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      brown = brown * 0.985 + (Math.random() * 2 - 1) * 0.15;
      data[i] = Math.max(-1, Math.min(1, brown * 1.8));
    }

    this.airNoise = ctx.createBufferSource();
    this.airNoise.buffer = noiseBuffer;
    this.airNoise.loop = true;
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.frequency.value = 900;
    this.airFilter.Q.value = 0.7;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    this.airNoise.connect(this.airFilter).connect(this.airGain).connect(this.master);
    this.airNoise.start();

    this.warpNoise = ctx.createBufferSource();
    this.warpNoise.buffer = noiseBuffer;
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
  }

  transient(kind) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = kind === 'warp' ? 'sawtooth' : 'triangle';
    osc.frequency.setValueAtTime(kind === 'warp' ? 72 : 54, now);
    osc.frequency.exponentialRampToValueAtTime(kind === 'warp' ? 360 : 105, now + (kind === 'warp' ? 1.4 : 0.38));
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(kind === 'warp' ? 620 : 420, now);
    filter.frequency.exponentialRampToValueAtTime(kind === 'warp' ? 3200 : 1200, now + 0.45);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(kind === 'warp' ? 0.22 : 0.12, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'warp' ? 1.8 : 0.55));
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + (kind === 'warp' ? 1.9 : 0.6));
  }

  update({ state, speed, atmosphere, boosting, warp, paused }) {
    if (!this.ready || !this.ctx) return;
    const now = this.ctx.currentTime;
    const set = (param, value, tau = 0.08) => param.setTargetAtTime(value, now, tau);
    const flight = state === 'space' || state === 'flyto' || state === 'takeoff' || state === 'landing';
    const speedK = clamp01(Math.log10(1 + Math.max(0, speed)) / 6.2);
    const boostK = boosting && state === 'space' ? 1 : 0;
    const warpK = clamp01(warp);
    const active = paused ? 0 : 1;

    set(this.master.gain, active * 0.24, 0.05);
    set(this.engineBus.gain, active * (flight ? 0.18 + speedK * 0.3 + boostK * 0.18 : 0.025), 0.1);
    set(this.engine.frequency, 38 + speedK * 86 + boostK * 34, 0.07);
    set(this.sub.frequency, 19 + speedK * 37 + boostK * 12, 0.09);
    set(this.engineFilter.frequency, 330 + speedK * 1450 + boostK * 900, 0.08);
    set(this.airGain.gain, active * atmosphere * (0.015 + speedK * 0.2 + boostK * 0.08), 0.12);
    set(this.airFilter.frequency, 520 + speedK * 2500 + boostK * 900, 0.1);
    set(this.warpGain.gain, active * warpK * 0.22, 0.06);
    set(this.warpFilter.frequency, 950 + warpK * 4200, 0.06);
    set(this.warpToneGain.gain, active * warpK * 0.09, 0.08);
    set(this.warpTone.frequency, 52 + warpK * 135, 0.06);

    if (boostK && !this.wasBoosting) this.transient('boost');
    if (warpK > 0.08 && !this.wasWarping) this.transient('warp');
    this.wasBoosting = !!boostK;
    this.wasWarping = warpK > 0.08;
  }

  setPaused(paused) {
    this.paused = paused;
    if (!this.ready || !this.ctx) return;
    this.master.gain.setTargetAtTime(paused ? 0 : 0.24, this.ctx.currentTime, 0.04);
  }
}
