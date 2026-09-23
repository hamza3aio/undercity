export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicOsc: OscillatorNode | null = null;
  private musicGain: GainNode | null = null;
  enabled = false;
  volume = 0.8;

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    this.enabled = true;
  }

  resume() {
    this.init();
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) this.master.gain.setValueAtTime(this.volume, this.ctx.currentTime);
  }

  blip(freq = 440, duration = 0.12, type: OscillatorType = "square", gain = 0.08) {
    if (!this.ctx || !this.enabled || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  // Distance-attenuated blip: volume scales with 1/(1+d*d*0.1).
  positional(freq: number, distance: number, duration = 0.12, type: OscillatorType = "square") {
    const att = 1 / (1 + distance * distance * 0.08);
    this.blip(freq, duration, type, 0.09 * att);
  }

  jump() { this.blip(520, 0.12, "square", 0.06); }
  land() { this.blip(180, 0.1, "triangle", 0.07); }
  pickup() { this.blip(880, 0.15, "sine", 0.08); }
  trigger() { this.blip(660, 0.2, "sine", 0.07); }

  startMusic(freq = 110, type: OscillatorType = "sawtooth", gain = 0.02) {
    if (!this.ctx || !this.master || this.musicOsc) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g).connect(this.master);
    osc.start();
    this.musicOsc = osc;
    this.musicGain = g;
  }

  stopMusic() {
    this.musicOsc?.stop();
    this.musicOsc?.disconnect();
    this.musicGain?.disconnect();
    this.musicOsc = null;
    this.musicGain = null;
  }
}
