// Glitch post stack v2 — a real pass graph, not a fixed grade/vignette.
//
// A pass describes both its CPU reference math (here, testable) and the GPU
// pass kind. The renderer executes the chain as: scene -> [offscreen passes]
// -> composite (grade + vignette). Anything the CPU cannot express in one
// fullscreen pass (e.g. true multi-tap bloom) runs as an offscreen pass with
// its own shader.
//
// Kinds: "grade" | "vignette" (composite) and "blur" | "bloom" | "ao" |
// "grain" | "sharpen" (offscreen). Bloom/AO are approximations: bloom is a
// downsampled bright-pass blur, AO is a depth-free 8-tap screen-space
// darkening. That is stated in the UI/docs rather than implied to be
// path-traced.

export type PostPassKind = "grade" | "vignette" | "blur" | "bloom" | "ao" | "grain" | "sharpen";

export const COMPOSITE_KINDS: PostPassKind[] = ["grade", "vignette"];
export const OFFSCREEN_KINDS: PostPassKind[] = ["blur", "bloom", "ao", "grain", "sharpen"];
export const POST_PASS_KINDS: PostPassKind[] = [...COMPOSITE_KINDS, ...OFFSCREEN_KINDS];

export interface GradeOpts {
  exposure: number; // EV stops, -4..4
  contrast: number; // 0..2
  saturation: number; // 0..2
  temperature: number; // -1..1 (blue <-> orange)
}

export interface VignetteOpts {
  strength: number; // 0..1
  /** Fraction of the frame radius left untouched: 0 = falloff from the
   * centre, 1 = falloff only at the very edge. */
  softness: number;
}

export interface BlurOpts {
  radius: number; // in texels, 0..16
  taps: number; // odd-ish sample count used by the reference math
}

export interface BloomOpts extends BlurOpts {
  threshold: number; // 0..2 brightness where bloom starts
  intensity: number; // 0..4
}

export interface AOOpts {
  strength: number; // 0..2
  radius: number; // 0..1 screen radius
}

export interface GrainOpts {
  amount: number; // 0..1
  /** Fixed seed keeps grain deterministic; a game can animate it. */
  seed: number;
}

export interface SharpenOpts {
  amount: number; // 0..2
}

export type PassOptions =
  | { kind: "grade"; opts: GradeOpts }
  | { kind: "vignette"; opts: VignetteOpts }
  | { kind: "blur"; opts: BlurOpts }
  | { kind: "bloom"; opts: BloomOpts }
  | { kind: "ao"; opts: AOOpts }
  | { kind: "grain"; opts: GrainOpts }
  | { kind: "sharpen"; opts: SharpenOpts };

// --- CPU reference math (mirrored by the GPU passes) ---

export const LUMA: [number, number, number] = [0.2126, 0.7152, 0.0722];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lumaOf(r: number, g: number, b: number): number {
  return r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
}

/** Exposure, temperature, contrast, saturation. Clamped to [0,1]. */
export function gradePixel(r: number, g: number, b: number, o: GradeOpts): [number, number, number] {
  const m = Math.pow(2, o.exposure);
  // Temperature pushes blue/orange around 0.5 luma.
  const t = o.temperature;
  let cr = r * m + t * 0.08;
  let cg = g * m;
  let cb = b * m - t * 0.08;
  cr = (cr - 0.5) * o.contrast + 0.5;
  cg = (cg - 0.5) * o.contrast + 0.5;
  cb = (cb - 0.5) * o.contrast + 0.5;
  const l = lumaOf(cr, cg, cb);
  cr = l + (cr - l) * o.saturation;
  cg = l + (cg - l) * o.saturation;
  cb = l + (cb - l) * o.saturation;
  return [clamp01(cr), clamp01(cg), clamp01(cb)];
}

export function vignetteFactor(nx: number, ny: number, o: VignetteOpts): number {
  if (!(o.strength > 0)) return 1;
  const d = Math.min(1, Math.hypot(nx, ny) / Math.SQRT2);
  const start = Math.max(0, Math.min(1, o.softness));
  if (d <= start) return 1;
  const span = Math.max(1e-6, 1 - start);
  const k = Math.min(1, (d - start) / span);
  return clamp01(1 - o.strength * k * k);
}

/** Bright-pass used by bloom: keeps only what is above the threshold. */
export function brightPass(r: number, g: number, b: number, threshold: number): [number, number, number] {
  const l = lumaOf(r, g, b);
  if (l <= threshold) return [0, 0, 0];
  const k = (l - threshold) / Math.max(1e-6, l);
  return [clamp01(r * k), clamp01(g * k), clamp01(b * k)];
}

/** Separable box blur reference (average of taps). */
export function blurFactor(samples: number[], radius: number, tap: number): number {
  if (!(radius > 0)) return samples[tap];
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.abs(i - tap) * radius;
    if (d > radius) continue;
    sum += samples[i];
    n++;
  }
  return n === 0 ? samples[tap] : sum / n;
}

/** Deterministic hash for film grain (same uv+time = same noise). */
export function grainNoise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Additive monochrome grain, scaled by amount. */
export function grainPixel(r: number, g: number, b: number, x: number, y: number, o: GrainOpts): [number, number, number] {
  const n = (grainNoise(x, y, o.seed) - 0.5) * o.amount;
  return [clamp01(r + n), clamp01(g + n), clamp01(b + n)];
}

/** Unsharp-mask style sharpen using 4 neighbours. */
export function sharpenPixel(
  c: number, left: number, right: number, up: number, down: number, amount: number
): number {
  const neighbours = (left + right + up + down) / 4;
  return clamp01(c + (c - neighbours) * amount);
}

/** Cheap 8-tap screen-space darkening: pixels darker than their neighbours. */
export function aoFactor(center: number, neighbours: number[], strength: number): number {
  if (neighbours.length === 0) return 1;
  let avg = 0;
  for (const n of neighbours) avg += n;
  avg /= neighbours.length;
  // centre darker than surroundings => occluded
  const diff = Math.max(0, avg - center);
  return clamp01(1 - strength * diff);
}

// --- the pass graph ---

export function defaultOptions(kind: PostPassKind): PassOptions {
  switch (kind) {
    case "grade": return { kind, opts: { exposure: 0, contrast: 1, saturation: 1, temperature: 0 } };
    case "vignette": return { kind, opts: { strength: 0.35, softness: 0.35 } };
    case "blur": return { kind, opts: { radius: 2, taps: 5 } };
    case "bloom": return { kind, opts: { radius: 3, taps: 5, threshold: 0.75, intensity: 0.6 } };
    case "ao": return { kind, opts: { strength: 0.6, radius: 0.25 } };
    case "grain": return { kind, opts: { amount: 0.04, seed: 1 } };
    case "sharpen": return { kind, opts: { amount: 0.4 } };
  }
}

function finite(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`post: ${name} must be a finite number`);
  return v;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sanitizeOptions(kind: PostPassKind, raw: unknown): PassOptions {
  if (typeof raw !== "object" || raw === null) return defaultOptions(kind);
  const s = raw as Record<string, unknown>;
  switch (kind) {
    case "grade":
      return { kind, opts: {
        exposure: clamp(finite(s.exposure ?? 0, "exposure"), -4, 4),
        contrast: clamp(finite(s.contrast ?? 1, "contrast"), 0, 2),
        saturation: clamp(finite(s.saturation ?? 1, "saturation"), 0, 2),
        temperature: clamp(finite(s.temperature ?? 0, "temperature"), -1, 1),
      } };
    case "vignette":
      return { kind, opts: {
        strength: clamp(finite(s.strength ?? 0.35, "strength"), 0, 1),
        softness: clamp(finite(s.softness ?? 0.35, "softness"), 0, 1),
      } };
    case "blur":
      return { kind, opts: { radius: clamp(finite(s.radius ?? 2, "radius"), 0, 16), taps: clamp(Math.round(finite(s.taps ?? 5, "taps")), 1, 17) } };
    case "bloom":
      return { kind, opts: {
        radius: clamp(finite(s.radius ?? 3, "radius"), 0, 16),
        taps: clamp(Math.round(finite(s.taps ?? 5, "taps")), 1, 17),
        threshold: clamp(finite(s.threshold ?? 0.75, "threshold"), 0, 2),
        intensity: clamp(finite(s.intensity ?? 0.6, "intensity"), 0, 4),
      } };
    case "ao":
      return { kind, opts: { strength: clamp(finite(s.strength ?? 0.6, "strength"), 0, 2), radius: clamp(finite(s.radius ?? 0.25, "radius"), 0, 1) } };
    case "grain":
      return { kind, opts: { amount: clamp(finite(s.amount ?? 0.04, "amount"), 0, 1), seed: finite(s.seed ?? 1, "seed") } };
    case "sharpen":
      return { kind, opts: { amount: clamp(finite(s.amount ?? 0.4, "amount"), 0, 2) } };
  }
}

export interface CompositeUniforms {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  vignette: number;
  vignetteSoftness: number;
}

export function neutralUniforms(): CompositeUniforms {
  return { exposure: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0, vignetteSoftness: 0.35 };
}

/** Offscreen pass state the renderer needs to execute the graph. */
export interface ResolvedPass {
  index: number;
  kind: PostPassKind;
  offscreen: boolean;
  options: PassOptions;
}

export class PostStack {
  enabled = false;
  passes: PassOptions[] = [];
  width = 0;
  height = 0;

  get count(): number {
    return this.passes.length;
  }

  kinds(): PostPassKind[] {
    return this.passes.map((p) => p.kind);
  }

  add(kind: PostPassKind): number {
    if (!POST_PASS_KINDS.includes(kind)) throw new Error(`post: unknown pass "${String(kind)}"`);
    this.passes.push(defaultOptions(kind));
    return this.passes.length - 1;
  }

  remove(i: number): boolean {
    if (!Number.isInteger(i) || i < 0 || i >= this.passes.length) return false;
    this.passes.splice(i, 1);
    return true;
  }

  move(from: number, to: number): boolean {
    const n = this.passes.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    const [p] = this.passes.splice(from, 1);
    this.passes.splice(to, 0, p);
    return true;
  }

  configure(i: number, partial: Record<string, unknown>): boolean {
    const p = this.passes[i];
    if (!p) return false;
    try {
      this.passes[i] = sanitizeOptions(p.kind, { ...(p.opts as unknown as Record<string, unknown>), ...partial });
      return true;
    } catch {
      // Garbage input is reported as "no change" rather than thrown at a UI.
      return false;
    }
  }

  clear(): void {
    this.passes.length = 0;
  }

  resize(w: number, h: number): void {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
      throw new Error("post: resize dimensions must be positive integers");
    }
    this.width = w;
    this.height = h;
  }

  /** Passes in execution order, tagged composite vs offscreen. */
  resolve(): ResolvedPass[] {
    return this.passes.map((p, index) => ({
      index, kind: p.kind, offscreen: OFFSCREEN_KINDS.includes(p.kind), options: p,
    }));
  }

  /** Merged uniforms for the single composite shader (last of a kind wins). */
  uniforms(): CompositeUniforms {
    const u = neutralUniforms();
    for (const p of this.passes) {
      if (p.kind === "grade") {
        u.exposure = p.opts.exposure;
        u.contrast = p.opts.contrast;
        u.saturation = p.opts.saturation;
        u.temperature = p.opts.temperature;
      } else if (p.kind === "vignette") {
        u.vignette = p.opts.strength;
        u.vignetteSoftness = p.opts.softness;
      }
    }
    return u;
  }

  toJSON(): { enabled: boolean; passes: PassOptions[] } {
    return { enabled: this.enabled, passes: this.passes.map((p) => sanitizeOptions(p.kind, p.opts)) };
  }

  static fromJSON(data: unknown): PostStack {
    const s = new PostStack();
    if (typeof data !== "object" || data === null) throw new Error("post: chain JSON must be an object");
    const d = data as { enabled?: unknown; passes?: unknown };
    s.enabled = d.enabled === true;
    if (!Array.isArray(d.passes)) throw new Error("post: chain JSON needs a passes array");
    for (const p of d.passes) {
      if (typeof p !== "object" || p === null) throw new Error("post: pass must be an object");
      const kind = (p as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !POST_PASS_KINDS.includes(kind as PostPassKind)) {
        throw new Error(`post: unknown pass "${String(kind)}"`);
      }
      s.passes.push(sanitizeOptions(kind as PostPassKind, (p as { opts?: unknown }).opts));
    }
    return s;
  }
}
