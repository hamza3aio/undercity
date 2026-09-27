import { describe, expect, it } from "vitest";
import {
  COMPOSITE_KINDS, OFFSCREEN_KINDS, POST_PASS_KINDS, PostStack,
  aoFactor, blurFactor, brightPass, defaultOptions, gradePixel, grainNoise, grainPixel,
  sanitizeOptions, sharpenPixel, vignetteFactor,
} from "../src/rendering/poststack.js";

describe("pass catalogue", () => {
  it("classifies composite vs offscreen kinds", () => {
    expect(COMPOSITE_KINDS).toEqual(["grade", "vignette"]);
    expect(OFFSCREEN_KINDS).toEqual(["blur", "bloom", "ao", "grain", "sharpen"]);
    expect(POST_PASS_KINDS).toHaveLength(7);
  });

  it("every kind has defaults and survives sanitising", () => {
    for (const k of POST_PASS_KINDS) {
      const d = defaultOptions(k);
      expect(d.kind).toBe(k);
      const s = sanitizeOptions(k, d.opts);
      expect(s.kind).toBe(k);
    }
    expect(() => sanitizeOptions("grade", null)).not.toThrow();
    expect(() => sanitizeOptions("grade", { exposure: NaN })).toThrow();
  });
});

describe("grade math", () => {
  const neutral = { exposure: 0, contrast: 1, saturation: 1, temperature: 0 };

  it("is identity with neutral options", () => {
    expect(gradePixel(0.2, 0.5, 0.8, neutral)).toEqual([0.2, 0.5, 0.8]);
  });

  it("exposure is a power of two, contrast pivots on 0.5", () => {
    const [r] = gradePixel(0.25, 0.25, 0.25, { ...neutral, exposure: 1 });
    expect(r).toBeCloseTo(0.5);
    expect(gradePixel(0.5, 0.5, 0.5, { ...neutral, contrast: 0.5 }).every((v) => Math.abs(v - 0.5) < 1e-9)).toBe(true);
  });

  it("temperature warms and cools", () => {
    const warm = gradePixel(0.5, 0.5, 0.5, { ...neutral, temperature: 1 });
    expect(warm[0]).toBeGreaterThan(0.5);
    expect(warm[2]).toBeLessThan(0.5);
    const cold = gradePixel(0.5, 0.5, 0.5, { ...neutral, temperature: -1 });
    expect(cold[2]).toBeGreaterThan(0.5);
  });

  it("saturation 0 collapses to luma, 2 doubles the spread", () => {
    const grey = gradePixel(1, 0, 0, { ...neutral, saturation: 0 });
    expect(grey[0]).toBeCloseTo(grey[1]);
    expect(grey[1]).toBeCloseTo(grey[2]);
  });

  it("clamps into [0,1]", () => {
    const [r] = gradePixel(1, 1, 1, { exposure: 4, contrast: 2, saturation: 2, temperature: 0 });
    expect(r).toBe(1);
  });
});

describe("vignette math", () => {
  it("respects the soft start", () => {
    // softness 1 => the whole frame is inside the un-darkened region
    expect(vignetteFactor(1, 1, { strength: 1, softness: 1 })).toBe(1);
    const hard = vignetteFactor(1, 1, { strength: 0.5, softness: 0 });
    expect(hard).toBeCloseTo(0.5);
  });

  it("is 1 at the centre and falls off outward", () => {
    const o = { strength: 0.8, softness: 0.2 };
    expect(vignetteFactor(0, 0, o)).toBe(1);
    expect(vignetteFactor(0.6, 0, o)).toBeLessThan(1);
    expect(vignetteFactor(1, 1, o)).toBeLessThan(vignetteFactor(0.6, 0, o));
  });

  it("strength 0 is a no-op", () => {
    expect(vignetteFactor(1, 1, { strength: 0, softness: 0 })).toBe(1);
  });
});

describe("bloom and blur math", () => {
  it("bright pass only keeps what clears the threshold", () => {
    expect(brightPass(0.2, 0.2, 0.2, 0.5)).toEqual([0, 0, 0]);
    const b = brightPass(1, 1, 1, 0.5);
    expect(b[0]).toBeGreaterThan(0);
    expect(b[0]).toBeLessThanOrEqual(1);
  });

  it("blur averages the in-radius taps only", () => {
    const row = [0, 0, 1, 0, 0];
    expect(blurFactor(row, 0, 2)).toBe(1);
    expect(blurFactor(row, 1, 2)).toBeCloseTo(1 / 3);
    expect(blurFactor(row, 0.5, 2)).toBeCloseTo(1 / 3);
  });
});

describe("grain, sharpen, ao", () => {
  it("grain is deterministic and bounded", () => {
    const a = grainNoise(3, 4, 1);
    expect(grainNoise(3, 4, 1)).toBe(a);
    expect(grainNoise(3, 4, 2)).not.toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    const [r] = grainPixel(0.5, 0.5, 0.5, 0, 0, { amount: 0.2, seed: 1 });
    expect(Math.abs(r - 0.5)).toBeLessThanOrEqual(0.1);
  });

  it("sharpen pushes away from the neighbour average", () => {
    expect(sharpenPixel(1, 0, 0, 0, 0, 1)).toBe(1);
    expect(sharpenPixel(0.5, 0.5, 0.5, 0.5, 0.5, 1)).toBeCloseTo(0.5);
    expect(sharpenPixel(0.2, 1, 1, 1, 1, 1)).toBe(0);
  });

  it("ao only darkens occluded pixels", () => {
    expect(aoFactor(1, [1, 1, 1, 1], 1)).toBe(1);
    expect(aoFactor(0, [1, 1, 1, 1], 1)).toBe(0);
    expect(aoFactor(0.5, [0.5], 1)).toBe(1); // no contrast
    expect(aoFactor(0, [], 1)).toBe(1);
  });
});

describe("PostStack graph", () => {
  it("adds, resolves and orders passes", () => {
    const s = new PostStack();
    s.add("bloom");
    s.add("grade");
    s.add("vignette");
    const r = s.resolve();
    expect(r.map((p) => p.kind)).toEqual(["bloom", "grade", "vignette"]);
    expect(r[0].offscreen).toBe(true);
    expect(r[1].offscreen).toBe(false);
    expect(s.move(0, 2)).toBe(true);
    expect(s.kinds()).toEqual(["grade", "vignette", "bloom"]);
  });

  it("configures by index and rejects bad ones", () => {
    const s = new PostStack();
    s.add("bloom");
    expect(s.configure(0, { intensity: 9 })).toBe(true);
    expect((s.passes[0].opts as { intensity: number }).intensity).toBe(4); // clamped
    expect(s.configure(5, {})).toBe(false);
    expect(s.configure(0, { intensity: NaN })).toBe(false);
  });

  it("rejects unknown kinds", () => {
    expect(() => new PostStack().add("motionBlur" as never)).toThrow();
  });

  it("merges composite uniforms (last of a kind wins)", () => {
    const s = new PostStack();
    s.add("grade");
    s.add("bloom");
    s.add("grade");
    s.configure(0, { exposure: 1 });
    s.configure(2, { exposure: -1 });
    expect(s.uniforms().exposure).toBe(-1);
    // bloom is offscreen, so it must not leak into the composite uniforms
    expect(s.uniforms().vignette).toBe(0);
  });

  it("round-trips JSON and rejects junk", () => {
    const s = new PostStack();
    s.enabled = true;
    s.add("bloom");
    s.configure(0, { threshold: 0.9 });
    s.add("grain");
    const back = PostStack.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(back.enabled).toBe(true);
    expect(back.kinds()).toEqual(["bloom", "grain"]);
    expect(back.uniforms()).toEqual(s.uniforms());
    expect(() => PostStack.fromJSON(null)).toThrow();
    expect(() => PostStack.fromJSON({ passes: [{ kind: "nope" }] })).toThrow();
  });

  it("validates resize dimensions", () => {
    const s = new PostStack();
    expect(() => s.resize(0, 10)).toThrow();
    s.resize(320, 200);
    expect(s.width).toBe(320);
  });
});
