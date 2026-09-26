// Glitch synth — procedural notes and step-sequencer timing, pure math.
// No AudioContext: playable through AudioEngine.playSample(), fully testable.

import { clipLength, type SampleClip } from "./sample.js";

export type WaveType = "sine" | "square" | "saw" | "triangle";

export interface NoteOpts {
  type?: WaveType;
  attack?: number; // seconds, linear ramp in
  decay?: number; // seconds, exponential tail after attack (default: rest of note)
  sampleRate?: number;
}

function osc(type: WaveType, phase: number): number {
  const p = phase % (Math.PI * 2);
  switch (type) {
    case "sine": return Math.sin(p);
    case "square": return p < Math.PI ? 1 : -1;
    case "saw": return p / Math.PI - 1;
    case "triangle": return Math.abs((p / Math.PI) % 2 - 1) * 2 - 1;
  }
}

// Synthesized note with attack ramp + exponential decay, peak-normalized
// to 0.89 (headroom against mixdown clipping).
export function synthNote(freq: number, seconds: number, opts: NoteOpts = {}): SampleClip {
  if (!(freq > 0) || !(seconds > 0)) throw new Error("synthNote: freq and seconds must be positive");
  const rate = opts.sampleRate ?? 44100;
  const type = opts.type ?? "sine";
  const attack = Math.min(opts.attack ?? 0.005, seconds);
  const decay = opts.decay ?? Math.max(0.01, seconds - attack);
  const n = Math.max(1, Math.floor(seconds * rate));
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let env = 1;
    if (t < attack) env = attack > 0 ? t / attack : 1;
    else env = Math.exp(-(t - attack) / decay);
    const v = osc(type, 2 * Math.PI * freq * t) * env;
    out[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const k = 0.89 / peak;
    for (let i = 0; i < n; i++) out[i] *= k;
  }
  return { sampleRate: rate, channels: [out] };
}

export interface SeqNote {
  beat: number;
  freq: number;
  beats: number;
}

export interface SeqEvent {
  start: number; // seconds
  freq: number;
  dur: number; // seconds (90% of the slot, staccato gap)
}

// Pure step-sequencer timing: beats + tempo -> scheduled events.
export function sequenceEvents(notes: SeqNote[], bpm: number): SeqEvent[] {
  if (!(bpm > 0)) throw new Error("sequenceEvents: bpm must be positive");
  const spb = 60 / bpm;
  return notes.map((n) => {
    if (!(n.freq > 0) || !(n.beats > 0) || n.beat < 0) {
      throw new Error("sequenceEvents: notes need beat >= 0, freq > 0, beats > 0");
    }
    return { start: n.beat * spb, freq: n.freq, dur: n.beats * spb * 0.9 };
  });
}

export function rms(clip: SampleClip): number {
  const ch = clip.channels[0];
  if (!ch || ch.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
  return Math.sqrt(sum / ch.length);
}

export function peak(clip: SampleClip): number {
  const ch = clip.channels[0];
  let m = 0;
  if (ch) for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  return m;
}

export function clipLengthSeconds(clip: SampleClip): number {
  return clipLength(clip) / clip.sampleRate;
}
