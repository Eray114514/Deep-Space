// Plays procedural synthesized sounds (sfx-generators.js + weapon-sfx.js) on the
// game's AudioContext: renders lazily, caches one AudioBuffer per variant, rotates
// variants, caps voices per sound, and pre-renders a warm list during idle
// time so the first shot never stalls the frame.
import { renderSound, SOUND_TABLE } from './sfx-generators.js';
import { renderWeaponSound, WEAPON_SOUND_TABLE } from '../weapons/weapon-sfx.js';

function lookupSoundDef(name) {
  return SOUND_TABLE[name] || WEAPON_SOUND_TABLE[name] || null;
}

function synthesizeSound(name, variant) {
  if (SOUND_TABLE[name]) return renderSound(name, variant);
  if (WEAPON_SOUND_TABLE[name]) return renderWeaponSound(name, variant);
  return null;
}

const idle = (fn) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 16));

export class ProceduralSfx {
  constructor() {
    this.ctx = null;
    this.bus = null;
    this.buffers = new Map();   // `${name}#${variant}` -> AudioBuffer
    this.nextVariant = new Map();
    this.voices = new Map();    // name -> [{ src, gain, end }]
    this.loops = new Map();     // name -> { src, gain }
    this.played = {};           // name -> count (diagnostics / tests)
  }

  attach(ctx, destination, gain = 1) {
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = gain;
    this.bus.connect(destination);
  }

  // Render the listed sounds (all variants) one per idle slice.
  prewarm(names) {
    const queue = [];
    for (const name of names) {
      const def = lookupSoundDef(name);
      if (def) for (let v = 0; v < (def.n || 1); v++) queue.push([name, v]);
    }
    const step = () => {
      const job = queue.shift();
      if (!job) return;
      this.buffer(job[0], job[1]);
      idle(step);
    };
    idle(step);
  }

  buffer(name, variant) {
    const key = `${name}#${variant}`;
    let buffer = this.buffers.get(key);
    if (buffer || !this.ctx) return buffer || null;
    const rendered = synthesizeSound(name, variant);
    if (!rendered) return null;
    buffer = this.ctx.createBuffer(rendered.ch.length, rendered.ch[0].length, rendered.sr);
    rendered.ch.forEach((data, i) => buffer.copyToChannel(data, i));
    this.buffers.set(key, buffer);
    return buffer;
  }

  // play(name, { gain, pitch, delay, variant }) -> source node or null
  play(name, { gain = 1, pitch = 1, delay = 0, variant = null } = {}) {
    const def = lookupSoundDef(name);
    if (!def || !this.ctx || !this.bus) return null;
    const count = def.n || 1;
    let v = variant;
    if (v === null) {
      v = this.nextVariant.get(name) || 0;
      this.nextVariant.set(name, (v + 1) % count);
    }
    const buffer = this.buffer(name, v % count);
    if (!buffer) return null;
    const now = this.ctx.currentTime + delay;
    const active = (this.voices.get(name) || []).filter((voice) => voice.end > this.ctx.currentTime);
    while (active.length >= (def.max || 4)) {
      const oldest = active.shift();
      oldest.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
      try { oldest.src.stop(this.ctx.currentTime + 0.05); } catch { /* already stopped */ }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch;
    const amp = this.ctx.createGain();
    amp.gain.value = gain;
    src.connect(amp).connect(this.bus);
    src.start(now);
    active.push({ src, gain: amp, end: now + buffer.duration / pitch });
    this.played[name] = (this.played[name] || 0) + 1;
    this.voices.set(name, active);
    return src;
  }

  // Looping bed (rain, wind…): fades toward `gain`; created on first use.
  loop(name, gain, tau = 0.6) {
    if (!this.ctx || !this.bus) return;
    let entry = this.loops.get(name);
    if (!entry) {
      if (gain <= 0.001) return;
      const buffer = this.buffer(name, 0);
      if (!buffer) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const amp = this.ctx.createGain();
      amp.gain.value = 0;
      src.connect(amp).connect(this.bus);
      src.start();
      entry = { src, gain: amp };
      this.loops.set(name, entry);
    }
    entry.gain.gain.setTargetAtTime(Math.max(0, gain), this.ctx.currentTime, tau);
  }

  // Independent looping voice with its own gain, pitch and stereo pan (a robot's
  // rotor or servo). Returns { setGain, setPitch, setPan, stop } or null.
  voice(name) {
    if (!this.ctx || !this.bus) return null;
    const buffer = this.buffer(name, 0);
    if (!buffer) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = 0;
    const amp = ctx.createGain();
    amp.gain.value = 0;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) src.connect(amp).connect(pan).connect(this.bus); else src.connect(amp).connect(this.bus);
    // start at a random point so two voices of the same loop never phase
    src.start(0, Math.random() * buffer.duration);
    let stopped = false;
    return {
      setGain: (g) => { if (!stopped) amp.gain.setTargetAtTime(Math.max(0, g), ctx.currentTime, 0.05); },
      setPitch: (p) => { if (!stopped) src.playbackRate.setTargetAtTime(Math.max(0.1, p), ctx.currentTime, 0.05); },
      setPan: (p) => { if (!stopped && pan) pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, p)), ctx.currentTime, 0.05); },
      stop: () => {
        if (stopped) return;
        stopped = true;
        amp.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        try { src.stop(ctx.currentTime + 0.3); } catch { /* already stopped */ }
      },
    };
  }

  dispose() {
    for (const { src } of this.loops.values()) { try { src.stop(); } catch { /* stopped */ } }
    this.loops.clear();
    this.bus?.disconnect();
    this.buffers.clear();
  }
}
