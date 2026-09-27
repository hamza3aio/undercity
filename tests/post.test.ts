import { describe, expect, it } from "vitest";
import {
  PostChain, bakeGradeLUT, defaultGrade, gradePixel, sampleLUT, sanitizeGrade,
  sanitizeVignette, vignetteFactor,
} from "../src/rendering/post.js";

describe("gradePixel", () => {
  it("is identity with neutral options", () => {
    expect(gradePixel(0.2, 0.5, 0.8, defaultGrade())).toEqual([0.2, 0.5, 0.8]);
  });

  it("applies exposure as powers of two", () => {
    const [r, g, b] = gradePixel(0.25, 0.25, 0.25, { exposure: 1, contrast: 1, saturation: 1 });
    expect(r).toBeCloseTo(0.5);
    expect(g).toBeCloseTo(0.5);
    expect(b).toBeCloseTo(0.5);
  });

  it("collapses to mid-gray at zero contrast", () => {
    expect(gradePixel(0.1, 0.9, 0.4, { exposure: 0, contrast: 0, saturation: 1 }))
      .toEqual([0.5, 0.5, 0.5]);
  });

  it("desaturates to luma at zero saturation", () => {
    const [r, g, b] = gradePixel(1, 0, 0, { exposure: 0, contrast: 1, saturation: 0 });
    expect(r).toBeCloseTo(0.2126);
    expect(g).toBeCloseTo(0.2126);
    expect(b).toBeCloseTo(0.2126);
  });

  it("clamps output to [0, 1]", () => {
    expect(gradePixel(1, 1, 1, { exposure: 4, contrast: 2, saturation: 2 }))
      .toEqual([1, 1, 1]);
    expect(gradePixel(0, 0, 0, { exposure: -4, contrast: 2, saturation: 2 }))
      .toEqual([0, 0, 0]);
  });
});

describe("vignetteFactor", () => {
  it("is 1 at center and disabled at strength 0", () => {
    expect(vignetteFactor(0, 0, 0.8)).toBe(1);
    expect(vignetteFactor(1, 1, 0)).toBe(1);
    expect(vignetteFactor(-0.7, 0.3, 0)).toBe(1);
  });

  it("darkens toward corners", () => {
    const c = vignetteFactor(0, 0, 0.5);
    const e = vignetteFactor(1, 0, 0.5);
    const k = vignetteFactor(1, 1, 0.5);
    expect(c).toBe(1);
    expect(e).toBeLessThan(c);
    expect(k).toBeLessThan(e);
    expect(k).toBeCloseTo(0.5); // corner d=1: 1 - 0.5*1
  });

  it("never goes negative at full strength", () => {
    expect(vignetteFactor(1, 1, 1)).toBe(0);
    expect(vignetteFactor(0.9, 0.9, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe("bakeGradeLUT / sampleLUT", () => {
  it("rejects bad sizes", () => {
    expect(() => bakeGradeLUT(1, defaultGrade())).toThrow();
    expect(() => bakeGradeLUT(2.5, defaultGrade())).toThrow();
  });

  it("bakes identity with neutral options", () => {
    const lut = bakeGradeLUT(4, defaultGrade());
    expect(lut).toHaveLength(4 * 4 * 4 * 3);
    // grid corner (1,0,0): r max, g/b min
    const k = (0 * 16 + 0 * 4 + 3) * 3;
    expect(lut[k]).toBeCloseTo(1);
    expect(lut[k + 1]).toBeCloseTo(0);
    expect(lut[k + 2]).toBeCloseTo(0);
  });

  it("matches gradePixel at grid points", () => {
    const o = { exposure: 0.5, contrast: 1.2, saturation: 0.8 };
    const lut = bakeGradeLUT(8, o);
    for (const [r, g, b] of [[0, 0, 0], [1, 1, 1], [3 / 7, 5 / 7, 1 / 7]] as const) {
      const [er, eg, eb] = gradePixel(r, g, b, o);
      const [ar, ag, ab] = sampleLUT(lut, 8, r, g, b);
      expect(ar).toBeCloseTo(er, 4);
      expect(ag).toBeCloseTo(eg, 4);
      expect(ab).toBeCloseTo(eb, 4);
    }
  });

  it("clamps out-of-range samples without NaN", () => {
    const lut = bakeGradeLUT(2, defaultGrade());
    const [r, g, b] = sampleLUT(lut, 2, 2, -1, 0.5);
    expect([r, g, b].every(Number.isFinite)).toBe(true);
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
  });
});

describe("sanitize", () => {
  it("clamps ranges and rejects non-finite input", () => {
    expect(sanitizeGrade({ exposure: 9, contrast: -1, saturation: 5 }))
      .toEqual({ exposure: 4, contrast: 0, saturation: 2 });
    expect(sanitizeVignette({ strength: 3 }).strength).toBe(1);
    expect(() => sanitizeGrade({ exposure: NaN, contrast: 1, saturation: 1 })).toThrow();
    expect(() => sanitizeVignette({ strength: Infinity })).toThrow();
  });
});

describe("PostChain", () => {
  it("adds, lists, and edits passes", () => {
    const c = new PostChain();
    expect(c.uniforms()).toEqual({ exposure: 0, contrast: 1, saturation: 1, vignette: 0 });
    const g = c.add("grade");
    const v = c.add("vignette");
    expect(c.kinds()).toEqual(["grade", "vignette"]);
    expect(c.setGrade(g, { exposure: 1 })).toBe(true);
    expect(c.setVignette(v, { strength: 0.5 })).toBe(true);
    expect(c.uniforms()).toMatchObject({ exposure: 1, vignette: 0.5 });
    expect(c.setGrade(v, { exposure: 1 })).toBe(false); // wrong kind
    expect(c.setVignette(99, {})).toBe(false); // out of bounds
  });

  it("last pass of a kind wins", () => {
    const c = new PostChain();
    c.add("grade");
    c.add("grade");
    c.setGrade(0, { exposure: 2 });
    c.setGrade(1, { exposure: -1 });
    expect(c.uniforms().exposure).toBe(-1);
  });

  it("removes and reorders", () => {
    const c = new PostChain();
    c.add("grade");
    c.add("vignette");
    expect(c.move(0, 1)).toBe(true);
    expect(c.kinds()).toEqual(["vignette", "grade"]);
    expect(c.move(0, 0)).toBe(false);
    expect(c.remove(5)).toBe(false);
    expect(c.remove(0)).toBe(true);
    expect(c.kinds()).toEqual(["grade"]);
    c.clear();
    expect(c.count).toBe(0);
  });

  it("rejects unknown kinds", () => {
    const c = new PostChain();
    expect(() => c.add("bloom" as never)).toThrow();
  });

  it("round-trips JSON and rejects bad payloads", () => {
    const c = new PostChain();
    c.enabled = true;
    c.add("grade");
    c.setGrade(0, { exposure: 0.5, contrast: 1.1, saturation: 0.9 });
    c.add("vignette");
    const back = PostChain.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
    expect(back.enabled).toBe(true);
    expect(back.kinds()).toEqual(["grade", "vignette"]);
    expect(back.uniforms()).toEqual(c.uniforms());
    expect(() => PostChain.fromJSON(null)).toThrow();
    expect(() => PostChain.fromJSON({ enabled: true })).toThrow();
    expect(() => PostChain.fromJSON({ passes: [{ kind: "bloom" }] })).toThrow();
    expect(() => PostChain.fromJSON({ passes: [{ kind: "grade" }] })).toThrow();
  });

  it("validates resize dimensions", () => {
    const c = new PostChain();
    expect(() => c.resize(0, 600)).toThrow();
    expect(() => c.resize(800.5, 600)).toThrow();
    c.resize(800, 600);
    expect(c.width).toBe(800);
    expect(c.height).toBe(600);
  });
});
