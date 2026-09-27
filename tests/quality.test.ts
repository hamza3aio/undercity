import { describe, expect, it } from "vitest";
import {
  QUALITY_LEVELS, QualitySettings, qualityPreset, sanitizeQuality, shouldRenderFrame,
} from "../src/core/quality.js";
import { acesFilm, linearToSrgb, reinhard, srgbToLinear, tonemapPixel, defaultTonemap } from "../src/rendering/tonemap.js";

describe("quality presets", () => {
  it("defines all four levels and scales them monotonically", () => {
    expect(QUALITY_LEVELS).toEqual(["low", "medium", "high", "ultra"]);
    let prevScale = 0, prevShadow = 0, prevParticles = 0;
    for (const l of QUALITY_LEVELS) {
      const p = qualityPreset(l);
      expect(p.level).toBe(l);
      expect(p.pixelScale).toBeGreaterThanOrEqual(prevScale);
      expect(p.shadowSize).toBeGreaterThanOrEqual(prevShadow);
      expect(p.particles).toBeGreaterThanOrEqual(prevParticles);
      prevScale = p.pixelScale; prevShadow = p.shadowSize; prevParticles = p.particles;
    }
    expect(qualityPreset("low").shadowSize).toBe(0); // shadows off at low
    expect(qualityPreset("ultra").fpsLimit).toBe(0); // uncapped at ultra
  });
});

describe("sanitizeQuality", () => {
  it("falls back to a preset for junk input", () => {
    expect(sanitizeQuality(null).level).toBe("high");
    expect(sanitizeQuality("nope").pixelScale).toBe(qualityPreset("high").pixelScale);
  });

  it("clamps every numeric field into range", () => {
    const q = sanitizeQuality({
      level: "high", pixelScale: 99, fpsLimit: -5, shadowSize: 1e9, shadowDistance: 0,
      viewDistance: 1e6, pointLights: 40, textureMaxSize: 1, particles: -3,
      gamma: 99, exposure: 0,
    });
    expect(q.pixelScale).toBe(1);
    expect(q.fpsLimit).toBe(0);
    expect(q.shadowSize).toBe(8192);
    expect(q.shadowDistance).toBe(5);
    expect(q.viewDistance).toBe(2000);
    expect(q.pointLights).toBe(4);
    expect(q.textureMaxSize).toBe(256);
    expect(q.particles).toBe(0);
    expect(q.gamma).toBe(3);
    expect(q.exposure).toBe(0.1);
  });

  it("rejects unknown enum values and ignores non-finite numbers", () => {
    expect(sanitizeQuality({ tonemap: "kraken" }).tonemap).toBe("none");
    expect(sanitizeQuality({ gamma: NaN }).gamma).toBe(qualityPreset("high").gamma);
    expect(sanitizeQuality({ level: "insane" }).level).toBe("high");
  });
});

describe("QualitySettings", () => {
  it("applies presets and partial patches", () => {
    const q = new QualitySettings("low");
    expect(q.level).toBe("low");
    q.applyPreset("ultra");
    expect(q.level).toBe("ultra");
    q.patch({ pixelScale: 0.7 });
    expect(q.config.pixelScale).toBe(0.7);
    expect(q.level).toBe("ultra"); // patch does not change the preset
  });

  it("converts fpsLimit to a frame budget", () => {
    const q = new QualitySettings("high");
    expect(q.fpsLimitMs).toBeCloseTo(1000 / 60);
    q.patch({ fpsLimit: 0 });
    expect(q.fpsLimitMs).toBe(0);
  });

  it("round-trips JSON and survives versionless/corrupt payloads", () => {
    const q = new QualitySettings("medium");
    q.patch({ viewDistance: 333 });
    const back = QualitySettings.fromJSON(JSON.parse(JSON.stringify(q.toJSON())));
    expect(back.config).toEqual(q.config);
    // A payload from a future/older version must not throw.
    expect(QualitySettings.fromJSON({ version: 99, config: {} }).level).toBe("high");
    expect(QualitySettings.fromJSON(null).level).toBe("high");
  });

  it("save/load are no-ops without storage and never throw", () => {
    const q = new QualitySettings("low");
    // Headless Node: no localStorage.
    expect(q.save()).toBe(false);
    expect(QualitySettings.load().level).toBe("high");
  });
});

describe("frame pacing", () => {
  it("caps the presented rate but always allows the first frame", () => {
    expect(shouldRenderFrame(0, 0)).toBe(true); // uncapped
    expect(shouldRenderFrame(5, 0)).toBe(true);
    expect(shouldRenderFrame(5, 16.6)).toBe(false);
    expect(shouldRenderFrame(16.7, 16.6)).toBe(true);
    // small tolerance so a 60Hz display does not stutter at the boundary
    expect(shouldRenderFrame(16.2, 16.6)).toBe(true);
  });
});

describe("tone mapping", () => {
  it("sRGB transfer round-trips", () => {
    for (const v of [0, 0.01, 0.2, 0.5, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
    expect(linearToSrgb(0.001)).toBeCloseTo(0.001 * 12.92, 6);
    expect(srgbToLinear(1)).toBeCloseTo(1, 6);
  });

  it("reinhard and aces compress to [0,1] and roll highlights off", () => {
    expect(reinhard(0)).toBe(0);
    expect(reinhard(1)).toBeCloseTo(0.5);
    expect(reinhard(1e6)).toBeLessThan(1);
    expect(acesFilm(0)).toBe(0);
    expect(acesFilm(1e6)).toBeLessThanOrEqual(1);
    expect(acesFilm(2)).toBeGreaterThan(acesFilm(1));
  });

  it("default mode is an exact no-op (clamp only)", () => {
    expect(tonemapPixel(0.25, 0.5, 2, defaultTonemap())).toEqual([0.25, 0.5, 1]);
  });

  it("exposure multiplies before the curve", () => {
    const a = tonemapPixel(0.5, 0.5, 0.5, { mode: "reinhard", exposure: 2, gamma: 1 });
    expect(a[0]).toBeCloseTo(reinhard(1.0));
  });

  it("gamma is a power law (gamma 2.2 ~= sRGB, not the exact piecewise curve)", () => {
    const [r] = tonemapPixel(0.5, 0.5, 0.5, { mode: "none", exposure: 1, gamma: 2.2 });
    expect(r).toBeCloseTo(Math.pow(0.5, 1 / 2.2), 6);
    // Close to, but not identical to, the piecewise sRGB transfer.
    expect(linearToSrgb(0.5)).toBeCloseTo(0.7354, 4);
    expect(r).toBeLessThan(linearToSrgb(0.5));
    expect(Math.abs(r - linearToSrgb(0.5))).toBeLessThan(0.01);
  });

  it("preserves hue relationships (per-channel curves)", () => {
    const [r, g, b] = tonemapPixel(0.8, 0.4, 0.2, { mode: "aces", exposure: 1, gamma: 2.2 });
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
});
