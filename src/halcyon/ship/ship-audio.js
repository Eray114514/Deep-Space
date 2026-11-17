// HALCYON VII ship sounds, synthesized like the rest of the game's audio.
//
// Two layers on the flight audio context:
//   bed     the cabin itself: life-support hum, air through the vents (louder
//           near a fan), a faint electrical whine from the avionics.  It only
//           plays while the listener is aboard (walking or in the seat), and it
//           drops when night watch turns the cabin down.
//   events  the things that move: sliding doors, lockers, switches, the brewer,
//           the cargo ramp and the landing gear.  Each event is placed in ship
//           space, so it is quieter with distance and panned by where the
//           walker is facing.
//
// Ship queues events (Ship.emit); ShipAudio drains the queue every frame.


/* fan positions (ship-local x, y, z) for the vent layer */
const FANS = [[-0.85, 2.5, 1.44], [0.85, 2.5, 4.16], [0, 2.2, -3.2]];

export class ShipAudio {
  constructor(flight) {
    this.flight = flight;
    this.bus = null;
  }

  ensure() {
    const f = this.flight;
    if (this.bus || !f?.ready || !f.ctx || !f.master || !f.noiseBuffer) return !!this.bus;
    const ctx = this.ctx = f.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(f.master);

    // life-support hum: 60 Hz fundamental, a soft second harmonic, rumble
    this.bed = ctx.createGain();
    this.bed.gain.value = 0;
    this.bed.connect(this.bus);
    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 58;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.55;
    hum.connect(humGain).connect(this.bed);
    const hum2 = ctx.createOscillator();
    hum2.type = 'triangle';
    hum2.frequency.value = 116.4;
    const hum2Gain = ctx.createGain();
    hum2Gain.gain.value = 0.10;
    hum2.connect(hum2Gain).connect(this.bed);
    const rumble = ctx.createBufferSource();
    rumble.buffer = f.noiseBuffer;
    rumble.loop = true;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 160;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.9;
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(this.bed);
    // air through the vents
    const air = ctx.createBufferSource();
    air.buffer = f.noiseBuffer;
    air.loop = true;
    air.playbackRate.value = 0.83;
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.value = 1100;
    airFilter.Q.value = 0.6;
    this.vent = ctx.createGain();
    this.vent.gain.value = 0;
    air.connect(airFilter).connect(this.vent).connect(this.bus);
    // avionics whine, only in the seat
    const whine = ctx.createOscillator();
    whine.type = 'sine';
    whine.frequency.value = 7350;
    this.whine = ctx.createGain();
    this.whine.gain.value = 0;
    whine.connect(this.whine).connect(this.bus);
    this.sources = [hum, hum2, rumble, air, whine];
    for (const node of this.sources) node.start();
    return true;
  }

  /**
   * @param {object} s  aboard, seated, listener {x, z, yaw} in ship space,
   *                    night (0..1 cabin dimming), paused, events (array)
   */
  update(s) {
    if (!this.ensure()) {
      if (s.events) s.events.length = 0;
      return;
    }
    const now = this.ctx.currentTime;
    const set = (param, value, tau = 0.25) => param.setTargetAtTime(value, now, tau);
    const live = s.paused ? 0 : 1;
    const aboard = s.aboard ? 1 : 0;
    const level = 0.45 + 0.55 * (s.cabin ?? 1);
    set(this.bed.gain, live * aboard * 0.045 * level, 0.6);
    let nearFan = 0;
    if (s.listener) {
      for (const [x, , z] of FANS) {
        nearFan = Math.max(nearFan, 1 / (1 + ((s.listener.x - x) ** 2 + (s.listener.z - z) ** 2) / 2.5));
      }
    }
    set(this.vent.gain, live * aboard * (0.010 + 0.05 * nearFan) * level, 0.4);
    set(this.whine.gain, live * (s.seated ? 0.0016 : 0), 0.5);
    for (const event of s.events || []) this.play(event, s);
    if (s.events) s.events.length = 0;
  }

  /** gain and pan for a ship-local source, heard from the listener */
  place(pos, s) {
    if (!pos || !s.listener) return { gain: s.aboard ? 1 : 0.35, pan: 0 };
    const dx = pos[0] - s.listener.x, dz = pos[2] - s.listener.z;
    const d = Math.hypot(dx, dz);
    const yaw = s.listener.yaw;
    const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const gain = (s.aboard ? 1 : 0.35) / (1 + (d / 3.2) ** 2);
    return { gain, pan: d > 0.05 ? Math.max(-1, Math.min(1, right / d)) * 0.75 : 0 };
  }

  play(event, s) {
    if (s.paused) return;
    const { gain, pan } = this.place(event.pos, s);
    if (gain < 0.01) return;
    const out = this.ctx.createStereoPanner();
    out.pan.value = pan;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    out.connect(g).connect(this.bus);
    const t = this.ctx.currentTime;
    const n = (o) => this.noise({ ...o, out, t });
    const tone = (o) => this.tone({ ...o, out, t });
    switch (event.type) {
      case 'door-open':
      case 'door-close': {
        const open = event.type === 'door-open';
        tone({ from: open ? 310 : 520, to: open ? 520 : 300, duration: 0.55, gain: 0.05, type: 'sawtooth', lowpass: 900 });
        n({ from: open ? 2600 : 900, to: open ? 700 : 2400, duration: 0.6, gain: 0.08, q: 0.7 });
        tone({ from: 95, to: 48, duration: 0.18, gain: 0.16, delay: 0.55, lowpass: 300 });
        n({ from: 300, to: 120, duration: 0.12, gain: 0.08, q: 1.2, delay: 0.56 });
        break;
      }
      case 'locker-open':
      case 'locker-close': {
        const open = event.type === 'locker-open';
        n({ from: 3800, to: 2600, duration: 0.05, gain: 0.07, q: 2.0 });          // latch
        tone({ from: 1450, to: 1300, duration: 0.05, gain: 0.03, lowpass: 4000 });
        n({ from: 520, to: open ? 380 : 700, duration: 0.42, gain: 0.04, q: 1.4, delay: 0.04 });
        if (!open) tone({ from: 160, to: 80, duration: 0.12, gain: 0.12, delay: 0.38, lowpass: 600 });
        break;
      }
      case 'switch':
        n({ from: 4200, to: 3000, duration: 0.03, gain: 0.08, q: 2.2 });
        tone({ from: 2100, to: 1800, duration: 0.03, gain: 0.025, lowpass: 6000 });
        tone({ from: 140, to: 90, duration: 0.08, gain: 0.05, delay: 0.02, lowpass: 400 });
        break;
      case 'lights-down':
        tone({ from: 240, to: 70, duration: 1.4, gain: 0.05, type: 'sawtooth', lowpass: 600, delay: 0.05 });
        break;
      case 'lights-up':
        tone({ from: 70, to: 240, duration: 1.1, gain: 0.04, type: 'sawtooth', lowpass: 700, delay: 0.05 });
        tone({ from: 880, to: 880, duration: 0.12, gain: 0.02, delay: 1.0, lowpass: 3000 });
        break;
      case 'brew': {
        tone({ from: 660, to: 660, duration: 0.09, gain: 0.03, lowpass: 3000 });
        tone({ from: 880, to: 880, duration: 0.12, gain: 0.03, delay: 0.11, lowpass: 3000 });
        tone({ from: 120, to: 135, duration: 3.6, gain: 0.04, type: 'sawtooth', lowpass: 380, delay: 0.3 });
        for (let i = 0; i < 18; i++) {
          n({ from: 900 + (i * 397) % 1500, to: 500, duration: 0.07, gain: 0.03, q: 3, delay: 1.0 + i * 0.14 + (i % 3) * 0.03 });
        }
        n({ from: 1800, to: 4200, duration: 1.4, gain: 0.05, q: 0.8, delay: 3.4 });       // steam
        tone({ from: 1320, to: 1320, duration: 0.35, gain: 0.03, delay: 4.9, lowpass: 4000 });
        break;
      }
      case 'ramp-open':
      case 'ramp-close':
        tone({ from: 140, to: event.type === 'ramp-open' ? 190 : 120, duration: 2.6, gain: 0.07, type: 'sawtooth', lowpass: 520 });
        n({ from: 700, to: 500, duration: 2.6, gain: 0.04, q: 0.9 });
        n({ from: 2400, to: 900, duration: 0.4, gain: 0.06, q: 0.7 });                 // seal hiss
        tone({ from: 70, to: 40, duration: 0.3, gain: 0.18, delay: 2.5, lowpass: 220 });
        break;
      case 'gear-down':
      case 'gear-up': {
        const down = event.type === 'gear-down';
        tone({ from: 60, to: 40, duration: 0.25, gain: 0.12, lowpass: 240 });          // doors unlock
        tone({ from: down ? 170 : 210, to: down ? 230 : 160, duration: 2.4, gain: 0.06, type: 'sawtooth', lowpass: 700, delay: 0.2 });
        n({ from: 900, to: 600, duration: 2.2, gain: 0.03, q: 1.1, delay: 0.2 });
        tone({ from: 85, to: 42, duration: 0.35, gain: 0.2, delay: 2.4, lowpass: 260 }); // down-and-locked
        n({ from: 260, to: 110, duration: 0.18, gain: 0.08, q: 1.3, delay: 2.42 });
        break;
      }
      default:
        break;
    }
    // let the nodes go once the longest cue has rung out
    setTimeout(() => { try { out.disconnect(); g.disconnect(); } catch { /* gone */ } }, 6500);
  }

  tone({ from, to, duration, gain, type = 'triangle', lowpass = 1800, delay = 0, out, t }) {
    const ctx = this.ctx;
    const at = t + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, from), at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + duration);
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + Math.min(0.04, duration * 0.2));
    amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(filter).connect(amp).connect(out);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }

  noise({ from, to, duration, gain, q = 0.8, delay = 0, out, t }) {
    const ctx = this.ctx;
    const at = t + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.flight.noiseBuffer;
    src.playbackRate.value = 0.9 + ((from * 7) % 23) / 100;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + duration);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + Math.min(0.03, duration * 0.2));
    amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    src.connect(filter).connect(amp).connect(out);
    src.start(at, ((from * 13) % 100) / 100);
    src.stop(at + duration + 0.05);
  }

  dispose() {
    for (const node of this.sources || []) {
      try { node.stop(); } catch { /* already stopped */ }
    }
    this.bus?.disconnect();
    this.bus = null;
  }
}

