import { describe, expect, it } from "vitest";
import { DEFAULT_PRESET, normalizePreset, presetToQuality } from "../src/game/qualitymap.js";
import { QUALITY_LEVELS, qualityPreset } from "../src/core/quality.js";

describe("preset -> engine quality mapping", () => {
  it("maps every game preset to a real engine level", () => {
    for (const p of ["Low", "Medium", "High", "Ultra"] as const) {
      const intent = presetToQuality(p);
      expect(QUALITY_LEVELS).toContain(intent.level);
      expect(intent.level).toBe(p.toLowerCase());
    }
  });

  it("keeps the game's view distances", () => {
    expect(presetToQuality("Low").viewDistance).toBe(40);
    expect(presetToQuality("Medium").viewDistance).toBe(70);
    expect(presetToQuality("High").viewDistance).toBe(100);
    expect(presetToQuality("Ultra").viewDistance).toBe(140);
  });

  it("always keeps the cinematic grade on", () => {
    for (const p of ["Low", "Medium", "High", "Ultra"] as const) {
      expect(presetToQuality(p).postEnabled).toBe(true);
    }
  });

  it("stays inside the engine's own view-distance bounds", () => {
    // The engine clamps to 20..2000; the game's values must survive a patch.
    for (const p of ["Low", "Medium", "High", "Ultra"] as const) {
      const preset = qualityPreset(presetToQuality(p).level);
      const patched = { ...preset, viewDistance: presetToQuality(p).viewDistance };
      expect(patched.viewDistance).toBeGreaterThanOrEqual(20);
      expect(patched.viewDistance).toBeLessThanOrEqual(2000);
    }
  });

  it("normalizes odd input to the default", () => {
    expect(normalizePreset("high")).toBe("High");
    expect(normalizePreset("ULTRA")).toBe("Ultra");
    expect(normalizePreset("potato")).toBe(DEFAULT_PRESET);
    expect(normalizePreset(undefined)).toBe(DEFAULT_PRESET);
    expect(normalizePreset(3)).toBe(DEFAULT_PRESET);
  });

  it("falls back to High view distance for an unknown preset", () => {
    expect(presetToQuality("Nope" as never).viewDistance).toBe(100);
  });
});
