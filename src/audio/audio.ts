import { clampGain } from "./volume.js";
import { renderArp, renderNoise, renderSweep, renderThump, type SynthOpts } from "./sfx.js";
import { sequenceEvents, type SeqNote } from "./synth.js";
import { clipLength, type SampleClip } from "./sample.js";
import type { Vec3 } from "../math/vec3.js";

export type Vec3Like = Pick<Vec3, "x" | "y" | "z">;

export interface AudioClip {
  name: string;
  buffer: AudioBuffer | null;
  duration: number;
  channels: number;
  sampleRate: number;
  state: "empty" | "loading" | "ready" | "error";
}

export interface VoiceOpts {
  gain?: number;
  group?: string;
  rate?: number;
  pos?: Vec3Like;
  vel?: Vec3Like;
}

function emptyClip(name: string): AudioClip {
  return { name, buffer: null, duration: 0, channels: 0, sampleRate: 0, state: "empty" };
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private groups = new Map<string, GainNode>();
  private groupVolumes = new Map<string, number>();
  private musicOsc: OscillatorNode | null = null;
  private musicGain: GainNode | null = null;
  private loops = new Map<string, { src: AudioBufferSourceNode; gain: GainNode }>();
  private clips = new Map<string, AudioClip>();
  private sampleBuffers = new WeakMap<object, AudioBuffer>();
  private sequences = new Map<string, { timer: number; timeout: boolean }>();
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
    this.loadVolumes();
  }

  resume() {
    this.init();
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) this.master.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    this.saveVolumes();
  }

  // ---- mixer groups ----
  group(name: string): GainNode | null {
    if (!this.ctx || !this.master) return null;
    let g = this.groups.get(name);
    if (!g) {
      g = this.ctx.createGain();
      g.gain.value = this.groupVolumes.get(name) ?? 1;
      g.connect(this.master);
      this.groups.set(name, g);
    }
    return g;
  }

  setGroupVolume(name: string, v: number) {
    const clamped = Math.max(0, Math.min(1, v));
    this.groupVolumes.set(name, clamped);
    const g = this.groups.get(name);
    if (g && this.ctx) g.gain.setValueAtTime(clamped, this.ctx.currentTime);
    this.saveVolumes();
  }

  groupVolume(name: string): number {
    return this.groupVolumes.get(name) ?? 1;
  }

  private out(group?: string): GainNode | null {
    if (!this.ctx || !this.master) return null;
    if (!group) return this.master;
    return this.group(group);
  }

  // ---- listener ----
  setListener(pos: Vec3Like, forward: Vec3Like = { x: 0, y: 0, z: -1 }, up: Vec3Like = { x: 0, y: 1, z: 0 }) {
    const l = this.ctx?.listener;
    if (!l) return;
    try {
      if (typeof l.setPosition === "function") {
        l.setPosition(pos.x, pos.y, pos.z);
        l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      } else {
        l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
        l.forwardX.value = forward.x; l.forwardY.value = forward.y; l.forwardZ.value = forward.z;
        l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
      }
    } catch { /* listener unavailable */ }
  }

  private panner(pos?: Vec3Like, vel?: Vec3Like): PannerNode | null {
    if (!this.ctx || !pos) return null;
    try {
      const p = this.ctx.createPanner();
      p.panningModel = "HRTF";
      p.distanceModel = "inverse";
      p.refDistance = 1;
      p.rolloffFactor = 1;
      if (typeof p.setPosition === "function") p.setPosition(pos.x, pos.y, pos.z);
      else {
        p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
      }
      if (vel) {
        try {
          // setVelocity was dropped from DOM types; probe structurally.
          const pv = p as unknown as { setVelocity?: (x: number, y: number, z: number) => void };
          if (typeof pv.setVelocity === "function") pv.setVelocity(vel.x, vel.y, vel.z);
        } catch { /* doppler velocity unsupported */ }
      }
      return p;
    } catch {
      return null;
    }
  }

  // ---- oscillator voices ----
  playTone(o: { freq?: number; duration?: number; type?: OscillatorType } & VoiceOpts = {}) {
    if (!this.ctx || !this.enabled) return;
    const dest = this.out(o.group);
    if (!dest) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = o.type ?? "square";
    osc.frequency.setValueAtTime(o.freq ?? 440, t);
    g.gain.setValueAtTime(clampGain(o.gain ?? 0.08), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (o.duration ?? 0.12));
    const pan = this.panner(o.pos, o.vel);
    osc.connect(g);
    if (pan) { g.connect(pan); pan.connect(dest); }
    else g.connect(dest);
    osc.start(t);
    osc.stop(t + (o.duration ?? 0.12) + 0.02);
  }

  blip(freq = 440, duration = 0.12, type: OscillatorType = "square", gain = 0.08) {
    this.playTone({ freq, duration, type, gain });
  }

  // Distance-attenuated blip: volume scales with 1/(1+d*d*0.1).
  // Kept gain-based (not panner-based) so legacy callers sound identical.
  positional(freq: number, distance: number, duration = 0.12, type: OscillatorType = "square") {
    const att = 1 / (1 + distance * distance * 0.08);
    this.blip(freq, duration, type, 0.09 * att);
  }

  jump() { this.blip(520, 0.12, "square", 0.06); }
  land() { this.blip(180, 0.1, "triangle", 0.07); }
  pickup() { this.blip(880, 0.15, "sine", 0.08); }
  trigger() { this.blip(660, 0.2, "sine", 0.07); }

  // ---- sample clips ----
  clip(name: string): AudioClip {
    let c = this.clips.get(name);
    if (!c) {
      c = emptyClip(name);
      this.clips.set(name, c);
    }
    return c;
  }

  async loadClip(name: string, url: string): Promise<AudioClip> {
    const c = this.clip(name);
    if (c.state === "ready" || c.state === "loading") return c;
    c.state = "loading";
    try {
      this.init();
      if (!this.ctx) throw new Error("no AudioContext");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.arrayBuffer();
      const buf: AudioBuffer = await new Promise((resolve, reject) => {
        this.ctx!.decodeAudioData(raw, resolve, reject);
      });
      c.buffer = buf;
      c.duration = buf.duration;
      c.channels = buf.numberOfChannels;
      c.sampleRate = buf.sampleRate;
      c.state = "ready";
    } catch {
      c.state = "error";
    }
    return c;
  }

  makeClip(name: string, samples: Float32Array, sampleRate = 22050): AudioClip {
    const c = this.clip(name);
    this.init();
    if (!this.ctx) {
      c.state = "error";
      return c;
    }
    const buf = this.ctx.createBuffer(1, samples.length, sampleRate);
    buf.getChannelData(0).set(samples);
    c.buffer = buf;
    c.duration = samples.length / sampleRate;
    c.channels = 1;
    c.sampleRate = sampleRate;
    c.state = "ready";
    return c;
  }

  playClip(name: string, o: VoiceOpts & { loop?: boolean } = {}): boolean {
    const c = this.clips.get(name);
    if (!c || c.state !== "ready" || !c.buffer) return false;
    return this.voice(c.buffer, o);
  }

  private voice(buffer: AudioBuffer, o: VoiceOpts & { loop?: boolean } = {}): boolean {
    if (!this.ctx || !this.enabled) return false;
    const dest = this.out(o.group);
    if (!dest) return false;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = o.loop ?? false;
    if (o.rate !== undefined) src.playbackRate.value = o.rate;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(clampGain(o.gain ?? 0.5), t);
    const pan = this.panner(o.pos, o.vel);
    src.connect(g);
    if (pan) { g.connect(pan); pan.connect(dest); }
    else g.connect(dest);
    src.start(t);
    return true;
  }

  // Play a pure SampleClip (WAV-decoded, synthesized, or mixed) by caching
  // its AudioBuffer conversion. Same contract as playClip.
  playSample(clip: SampleClip, o: VoiceOpts & { loop?: boolean } = {}): boolean {
    if (!this.ctx || !this.enabled) return false;
    let buf = this.sampleBuffers.get(clip);
    if (!buf) {
      if (clip.channels.length === 0 || clipLength(clip) === 0) return false;
      try {
        buf = this.ctx.createBuffer(clip.channels.length, clipLength(clip), clip.sampleRate);
        for (let c = 0; c < clip.channels.length; c++) {
          buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).set(clip.channels[c].subarray(0, buf.length));
        }
        this.sampleBuffers.set(clip, buf);
      } catch {
        return false;
      }
    }
    return this.voice(buf, o);
  }

  // ---- procedural synth SFX (real buffers, no assets) ----
  playSynth(kind: "thump" | "noise" | "sweep" | "arp", o: SynthOpts & VoiceOpts & { from?: number; to?: number; notes?: number[] } = {}): boolean {
    const samples =
      kind === "thump" ? renderThump(o) :
      kind === "noise" ? renderNoise(o) :
      kind === "sweep" ? renderSweep(o) :
      renderArp(o);
    const name = `__synth_${kind}`;
    this.makeClip(name, samples, o.sampleRate ?? 22050);
    return this.playClip(name, o);
  }

  // ---- music: drone + loop layers ----
  startMusic(freq = 110, type: OscillatorType = "sawtooth", gain = 0.02) {
    if (!this.ctx || !this.enabled) return;
    const dest = this.out("music");
    if (!dest || this.musicOsc) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g).connect(dest);
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

  startLoop(id: string, clipName: string, gain = 0.3, rate = 1) {
    if (!this.ctx || !this.enabled || this.loops.has(id)) return false;
    const c = this.clips.get(clipName);
    if (!c || c.state !== "ready" || !c.buffer) return false;
    const dest = this.out("music");
    if (!dest) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = c.buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = clampGain(gain);
    src.connect(g).connect(dest);
    src.start();
    this.loops.set(id, { src, gain: g });
    return true;
  }

  stopLoop(id: string) {
    const l = this.loops.get(id);
    if (!l) return;
    try { l.src.stop(); } catch { /* already stopped */ }
    l.src.disconnect();
    l.gain.disconnect();
    this.loops.delete(id);
  }

  stopAllLoops() {
    for (const id of [...this.loops.keys()]) this.stopLoop(id);
  }

  // ---- step sequencer (lookahead scheduling over sequenceEvents timing) ----
  private toneAt(freq: number, when: number, dur: number, o: { gain?: number; group?: string; type?: OscillatorType; pos?: Vec3Like }): void {
    if (!this.ctx) return;
    const dest = this.out(o.group ?? "music");
    if (!dest) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = o.type ?? "square";
    osc.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(clampGain(o.gain ?? 0.12), when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.02, dur));
    const pan = this.panner(o.pos);
    osc.connect(g);
    if (pan) { g.connect(pan); pan.connect(dest); }
    else g.connect(dest);
    osc.start(when);
    osc.stop(when + Math.max(0.03, dur) + 0.05);
  }

  playSequence(
    id: string,
    notes: SeqNote[],
    bpm: number,
    o: { loop?: boolean; group?: string; gain?: number; type?: OscillatorType } = {}
  ): boolean {
    if (!this.ctx || !this.enabled || this.sequences.has(id)) return false;
    const events = sequenceEvents(notes, bpm); // throws descriptive on bad notes
    if (events.length === 0) return false;
    const total = events.reduce((m, e) => Math.max(m, e.start + e.dur), 0);
    if (!o.loop) {
      const startAt = this.ctx.currentTime + 0.05;
      for (const ev of events) this.toneAt(ev.freq, startAt + ev.start, ev.dur, o);
      const timer = window.setTimeout(() => this.sequences.delete(id), (total + 0.6) * 1000);
      this.sequences.set(id, { timer, timeout: true });
      return true;
    }
    let next = this.ctx.currentTime + 0.05;
    const timer = window.setInterval(() => {
      if (!this.ctx || !this.sequences.has(id)) return;
      const horizon = this.ctx.currentTime + 0.15;
      while (next < horizon) {
        for (const ev of events) this.toneAt(ev.freq, next + ev.start, ev.dur, o);
        next += Math.max(total, 0.05);
      }
    }, 40);
    this.sequences.set(id, { timer, timeout: false });
    return true;
  }

  stopSequence(id: string) {
    const s = this.sequences.get(id);
    if (!s) return;
    if (s.timeout) window.clearTimeout(s.timer);
    else window.clearInterval(s.timer);
    this.sequences.delete(id);
  }

  stopAllSequences() {
    for (const id of [...this.sequences.keys()]) this.stopSequence(id);
  }

  // ---- volume persistence ----
  saveVolumes() {
    try {
      localStorage.setItem("glitch-audio-v1", JSON.stringify({
        master: this.volume,
        groups: Object.fromEntries(this.groupVolumes),
      }));
    } catch { /* storage unavailable */ }
  }

  loadVolumes() {
    try {
      const raw = localStorage.getItem("glitch-audio-v1");
      if (!raw) return;
      const data = JSON.parse(raw) as { master?: unknown; groups?: unknown };
      if (typeof data.master === "number") {
        this.volume = Math.max(0, Math.min(1, data.master));
        if (this.master && this.ctx) this.master.gain.value = this.volume;
      }
      if (data.groups && typeof data.groups === "object") {
        for (const [k, v] of Object.entries(data.groups as Record<string, unknown>)) {
          if (typeof v === "number") this.groupVolumes.set(k, Math.max(0, Math.min(1, v)));
        }
      }
    } catch { /* corrupt or unavailable: keep defaults */ }
  }
}
