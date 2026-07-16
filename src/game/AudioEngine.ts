export class AudioEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private engine?: OscillatorNode;
  private engineGain?: GainNode;
  private engineFilter?: BiquadFilterNode;
  private engineSub?: OscillatorNode;
  private engineSubGain?: GainNode;
  private wind?: AudioBufferSourceNode;
  private windGain?: GainNode;
  private boostGain?: GainNode;
  private boostFilter?: BiquadFilterNode;

  async start(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.62;
      this.master.connect(this.context.destination);
      this.buildEngine();
      this.buildWind();
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  setFlight(speed: number, atmosphere: number, boost = 0): void {
    if (!this.context || !this.engine || !this.engineGain || !this.engineFilter || !this.engineSub || !this.engineSubGain || !this.windGain || !this.boostGain || !this.boostFilter) return;
    const t = this.context.currentTime;
    const limitedSpeed = Math.min(speed, 7200); const drive = Math.min(limitedSpeed / 2200, 1);
    this.engine.frequency.setTargetAtTime(46 + Math.min(limitedSpeed, 1400) * .16 + boost * 42, t, .055);
    this.engineGain.gain.setTargetAtTime(.032 + drive * .12 + boost * .045, t, .075);
    this.engineFilter.frequency.setTargetAtTime(210 + Math.min(limitedSpeed, 2600) * .82 + boost * 1450, t, .065);
    this.engineSub.frequency.setTargetAtTime(24 + Math.min(limitedSpeed, 1800) * .042 + boost * 15, t, .075);
    this.engineSubGain.gain.setTargetAtTime(.018 + drive * .035 + boost * .058, t, .09);
    this.windGain.gain.setTargetAtTime(atmosphere * Math.min(speed / 420, .3), t, .11);
    this.boostFilter.frequency.setTargetAtTime(720 + drive * 980 + boost * 2300, t, .06);
    this.boostGain.gain.setTargetAtTime(Math.pow(boost, 1.25) * (.105 + drive * .055), t, boost > .05 ? .045 : .14);
  }

  pulse(kind: 'ui' | 'scan' | 'warp' | 'land' | 'shot'): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    const values = {
      ui: [620, 0.08, 0.05], scan: [180, 0.8, 0.16], warp: [62, 2.4, 0.28], land: [92, 0.55, 0.18], shot: [105, 0.16, 0.2],
    } as const;
    const [frequency, duration, volume] = values[kind];
    osc.type = kind === 'ui' ? 'sine' : kind === 'shot' ? 'square' : 'sawtooth';
    osc.frequency.setValueAtTime(frequency, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(28, frequency * (kind === 'scan' ? 4 : 0.45)), now + duration);
    filter.type = 'lowpass';
    filter.frequency.value = kind === 'warp' ? 720 : 2200;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(now); osc.stop(now + duration + 0.05);
  }

  warpSweep(intensity: number): void {
    if (!this.context || !this.engineFilter) return;
    this.engineFilter.frequency.setTargetAtTime(300 + intensity * 5200, this.context.currentTime, 0.04);
  }

  private buildEngine(): void {
    if (!this.context || !this.master) return;
    this.engine = this.context.createOscillator();
    this.engineGain = this.context.createGain();
    this.engineFilter = this.context.createBiquadFilter();
    this.engineSub = this.context.createOscillator();
    this.engineSubGain = this.context.createGain();
    this.engine.type = 'sawtooth'; this.engine.frequency.value = 48;
    this.engineSub.type = 'triangle'; this.engineSub.frequency.value = 24;
    this.engineGain.gain.value = 0.04;
    this.engineSubGain.gain.value = .018;
    this.engineFilter.type = 'lowpass'; this.engineFilter.frequency.value = 260;
    this.engine.connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    this.engineSub.connect(this.engineSubGain).connect(this.master);
    this.engine.start(); this.engineSub.start();
  }

  private buildWind(): void {
    if (!this.context || !this.master) return;
    const length = this.context.sampleRate * 2;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) { last = last * 0.985 + (Math.random() * 2 - 1) * 0.15; data[i] = last; }
    this.wind = this.context.createBufferSource();
    this.windGain = this.context.createGain();
    this.boostGain = this.context.createGain();
    this.boostFilter = this.context.createBiquadFilter();
    const filter = this.context.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 620;
    this.boostFilter.type = 'bandpass'; this.boostFilter.frequency.value = 980; this.boostFilter.Q.value = .48;
    this.wind.buffer = buffer; this.wind.loop = true; this.windGain.gain.value = 0;
    this.boostGain.gain.value = 0;
    this.wind.connect(filter).connect(this.windGain).connect(this.master);
    this.wind.connect(this.boostFilter).connect(this.boostGain).connect(this.master);
    this.wind.start();
  }
}
