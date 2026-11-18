import { makeRng } from './rng.js';

// A helmet hears two different things: turbulent low pressure at the ears
// and broadband wind past the suit. After line stretch the loudest nearby
// source is the fabric overhead. All three paths share one stereo recording.
function windBuffer(ctx) {
  const rate = 24000, length = rate * 4;
  const out = ctx.createBuffer(2, length, rate);
  const random = makeRng('audio:jump:air');
  for (let ear = 0; ear < 2; ear++) {
    const data = out.getChannelData(ear);
    let drift = 0, pink = 0;
    for (let i = 0; i < length; i++) {
      const white = random() * 2 - 1;
      drift = .982 * drift + .093 * white;
      pink = .76 * pink + .34 * white;
      data[i] = .46 * white + .72 * pink + drift;
    }
    // Bridge the loop seam with the preceding phase, retaining the same RMS.
    let tail = data[length - 1];
    for (let i = 0; i < 320; i++) {
      const k = i / 320;
      tail = tail * .93 + data[length - 321 + i] * .07;
      data[i] = tail * (1 - k) + data[i] * k;
    }
  }
  return out;
}

export class SkydiveAudio {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;
    this.buffer = windBuffer(ctx);
    this.source = null;
  }

  start() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0, ctx.currentTime);
    bus.connect(this.output);
    const band = (type, q) => {
      const filter = ctx.createBiquadFilter(), gain = ctx.createGain();
      filter.type = type;
      filter.Q.value = q;
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(bus);
      return { filter, gain };
    };
    this.body = band('lowpass', .55);
    this.air = band('bandpass', .64);
    this.cloth = band('bandpass', 1.75);
    const nodes = [this.body, this.air, this.cloth];
    src.onended = () => {
      src.disconnect();
      for (const { filter, gain } of nodes) { filter.disconnect(); gain.disconnect(); }
      bus.disconnect();
    };
    src.start();
    this.bus = bus;
    this.source = src;
  }

  update(speed, canopy, cloud, brake, paused) {
    if (!this.source) this.start();
    const now = this.ctx.currentTime;
    const pressure = Math.min(1, Math.sqrt(Math.max(0, speed) / 195));
    const open = Math.min(1, Math.max(0, (canopy - .18) / .64));
    const gust = .86 + .095 * Math.sin(now * 2.81) + .045 * Math.sin(now * 5.27 + 1.8);
    const flutter = Math.pow(.5 + .5 * Math.sin(now * 21 + 2.7 * Math.sin(now * 3.3)), 2);
    const set = (param, value, time = .1) => param.setTargetAtTime(value, now, time);
    set(this.bus.gain, paused ? 0 : 1, .045);
    set(this.source.playbackRate, .75 + pressure * .55 + open * .18);
    set(this.body.filter.frequency, 145 + pressure * 390 + cloud * 150);
    set(this.body.gain.gain, pressure * gust * (1.55 - open * 1.19) * (1 + cloud * .23));
    set(this.air.filter.frequency, (680 + pressure * 1940) * (1 - cloud * .49));
    set(this.air.gain.gain, (.10 + pressure * .94) * (1 - open * .81) * (1 - .30 * cloud));
    set(this.cloth.filter.frequency, 940 + 620 * brake + 120 * gust);
    set(this.cloth.gain.gain, open * (.11 + .26 * flutter + .17 * brake), .025);
  }

  release() {
    if (!this.source) return;
    const now = this.ctx.currentTime;
    this.bus.gain.setTargetAtTime(0, now, .045);
    this.source.stop(now + .25);
    this.source = null;
  }
}
