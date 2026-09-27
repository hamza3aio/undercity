// UNDERCITY graphics presets -> engine quality config.
//
// The engine re-applies `Engine.quality` every frame, so the game cannot
// poke the renderer directly: it has to express its intent as a quality
// level plus the two fields it owns (view distance and the cinematic
// grade). That mapping is pure, so it is unit tested instead of being
// discovered by playing the game on a weak machine.

export type GamePreset = "Low" | "Medium" | "High" | "Ultra";
export type EngineLevel = "low" | "medium" | "high" | "ultra";

export interface QualityIntent {
  level: EngineLevel;
  /** Far plane / fog far, tuned to the city's street scale. */
  viewDistance: number;
  /** The grade + vignette passes are the game's look: always on. */
  postEnabled: boolean;
}

/** View distance per preset, matching the original renderer.far values. */
const VIEW_DISTANCE: Record<GamePreset, number> = {
  Low: 40,
  Medium: 70,
  High: 100,
  Ultra: 140,
};

export function presetToQuality(preset: GamePreset): QualityIntent {
  return {
    level: preset.toLowerCase() as EngineLevel,
    viewDistance: VIEW_DISTANCE[preset] ?? VIEW_DISTANCE.High,
    postEnabled: true,
  };
}

/** The default when the settings payload is missing or malformed. */
export const DEFAULT_PRESET: GamePreset = "High";

export function normalizePreset(raw: unknown): GamePreset {
  if (typeof raw !== "string") return DEFAULT_PRESET;
  const match = (["Low", "Medium", "High", "Ultra"] as GamePreset[]).find(
    (p) => p.toLowerCase() === raw.toLowerCase()
  );
  return match ?? DEFAULT_PRESET;
}
