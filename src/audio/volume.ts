// Glitch audio math — pure volume/attenuation helpers (headless-testable).
// The WebAudio graph itself (audio.ts) needs a browser; these formulas are
// what it implements, pinned here.

export function dbToGain(db: number): number {
  if (db <= -100) return 0;
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  if (gain <= 0) return -Infinity;
  return 20 * Math.log10(gain);
}

// Inverse distance model (matches PannerNode distanceModel "inverse"
// with refDistance=ref, rolloffFactor=rolloff): 1 at ref, ~1/2 at 2*ref.
export function inverseAttenuation(distance: number, ref = 1, rolloff = 1): number {
  const d = Math.max(0, distance);
  if (d <= ref) return 1;
  return ref / (ref + rolloff * (d - ref));
}

export function clampGain(v: number): number {
  return Math.max(0, Math.min(2, v));
}
