// Glitch synth SFX — procedural sample buffers, no audio assets needed.
// Each renderer is PURE (Float32Array out, injectable rand) so tests pin it;
// audio.ts wraps them into AudioBuffers in the browser.

export type Rand = () => number;

export interface SynthOpts {
  sampleRate?: number; // default 22050 (SFX don't need 44.1k)
  duration?: number; // seconds
  freq?: number; // base Hz for tonal kinds
  gain?: number; // peak 0..1
  rand?: Rand;
}

function ctxOf(o: SynthOpts): { sr: number; n: number; rand: Rand } {
  const sr = o.sampleRate ?? 22050;
  const n = Math.max(1, Math.floor(sr * (o.duration ?? 0.2)));
  return { sr, n, rand: o.rand ?? Math.random };
}

function envelope(i: number, n: number, attack = 0.05): number {
  const t = i / n;
  const a = Math.min(1, t / Math.max(attack, 1e-3));
  return a * (1 - t) * (1 - t);
}

// Short filtered-noise thump (footsteps, landings, UI knocks).
export function renderThump(o: SynthOpts = {}): Float32Array {
  const { n, rand } = ctxOf(o);
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const noise = rand() * 2 - 1;
    last = last * 0.82 + noise * 0.18; // one-pole lowpass
    out[i] = last * envelope(i, n) * (o.gain ?? 0.9);
  }
  return out;
}

// Airy noise burst (pickups, whooshes, rain-ish beds).
export function renderNoise(o: SynthOpts = {}): Float32Array {
  const { n, rand } = ctxOf(o);
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const noise = rand() * 2 - 1;
    last = last * 0.4 + noise * 0.6; // brighter than thump
    out[i] = last * envelope(i, n, 0.15) * (o.gain ?? 0.5);
  }
  return out;
}

// Pitch sweep up/down (jumps, lasers-ish UI, alerts).
export function renderSweep(o: SynthOpts & { from?: number; to?: number } = {}): Float32Array {
  const { sr, n } = ctxOf(o);
  const out = new Float32Array(n);
  const from = o.from ?? (o.freq ?? 300);
  const to = o.to ?? (o.freq ?? 300) * 2;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = from + (to - from) * (i / n);
    phase += (2 * Math.PI * f) / sr;
    out[i] = Math.sin(phase) * envelope(i, n, 0.02) * (o.gain ?? 0.5);
  }
  return out;
}

// N-note arpeggio of sine blips (coins, wins, level-ups).
export function renderArp(o: SynthOpts & { notes?: number[] } = {}): Float32Array {
  const { sr, n } = ctxOf(o);
  const notes = o.notes ?? [523.25, 659.25, 783.99];
  const out = new Float32Array(n);
  const per = n / notes.length;
  for (let s = 0; s < notes.length; s++) {
    let phase = 0;
    const start = Math.floor(s * per);
    const end = Math.min(n, Math.floor((s + 1) * per));
    for (let i = start; i < end; i++) {
      phase += (2 * Math.PI * notes[s]) / sr;
      const local = (i - start) / Math.max(1, end - start);
      out[i] += Math.sin(phase) * (1 - local) * (o.gain ?? 0.4);
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 1) for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}
