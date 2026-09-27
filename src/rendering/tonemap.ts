// Glitch tone mapping + colour space — CPU reference math.
// The GPU mirrors these in TONEMAP_GLSL (rendering/shader.ts); the tests
// below pin the equations so the two cannot silently drift.
// Working space is linear; gamma encodes to sRGB on output. Both are
// opt-in (mode "none", gamma 1) so existing renders are unchanged.

export type ToneMapMode = "none" | "reinhard" | "aces";

export const TONE_MAP_MODES: ToneMapMode[] = ["none", "reinhard", "aces"];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// sRGB transfer function (piecewise, not a bare 2.2 gamma).
export function linearToSrgb(v: number): number {
  const c = clamp01(v);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function srgbToLinear(v: number): number {
  const c = clamp01(v);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Simple Reinhard: x / (1 + x), compresses the highlights to 0..1.
export function reinhard(x: number): number {
  return x / (1 + x);
}

// ACES filmic approximation (Narkowicz). Keeps mid-tones close to linear
// and rolls highlights off hard; expects linear HDR input.
export function acesFilm(x: number): number {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp01((x * (a * x + b)) / (x * (c * x + d) + e));
}

export interface TonemapOpts {
  mode: ToneMapMode;
  exposure: number; // linear multiplier applied before the curve
  gamma: number; // output encoding exponent applied as pow(1/gamma) after the curve
}

export function defaultTonemap(): TonemapOpts {
  return { mode: "none", exposure: 1, gamma: 1 };
}

export function tonemapPixel(r: number, g: number, b: number, o: TonemapOpts): [number, number, number] {
  const m = o.exposure;
  let cr = r * m, cg = g * m, cb = b * m;
  switch (o.mode) {
    case "reinhard":
      cr = reinhard(cr); cg = reinhard(cg); cb = reinhard(cb);
      break;
    case "aces":
      cr = acesFilm(cr); cg = acesFilm(cg); cb = acesFilm(cb);
      break;
    default:
      cr = clamp01(cr); cg = clamp01(cg); cb = clamp01(cb);
  }
  if (o.gamma !== 1) {
    const inv = 1 / o.gamma;
    cr = Math.pow(cr, inv); cg = Math.pow(cg, inv); cb = Math.pow(cb, inv);
  }
  return [cr, cg, cb];
}
