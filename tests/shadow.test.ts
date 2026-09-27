import { describe, expect, it } from "vitest";
import { Mat4 } from "../src/math/mat4.js";
import { Vec3 } from "../src/math/vec3.js";
import {
  MAX_SHADOW_SIZE, MIN_SHADOW_SIZE,
  fitDirectionalShadow, normalOffsetWorld, pcfKernel, sanitizeShadowSize,
  shadowDepthBias, shadowSample, sphereInsideShadow,
} from "../src/rendering/shadowmap.js";

const LIGHT = new Vec3(-0.5, -1, -0.3); // matches Renderer.lightDir default

describe("Mat4.ortho / transformPoint", () => {
  it("maps the ortho box onto the NDC cube", () => {
    const p = Mat4.ortho(-10, 10, -10, 10, 0, 100);
    // near/far are distances in front of the eye: view-space z = -distance.
    expect(p.transformPoint(new Vec3(0, 0, -0)).z).toBeCloseTo(-1);
    expect(p.transformPoint(new Vec3(0, 0, -100)).z).toBeCloseTo(1);
    expect(p.transformPoint(new Vec3(10, -10, -50)).x).toBeCloseTo(1);
    expect(p.transformPoint(new Vec3(-10, 10, -50)).y).toBeCloseTo(1);
  });

  it("is linear in distance from the eye (no perspective divide)", () => {
    const p = Mat4.ortho(-1, 1, -1, 1, 0, 10);
    expect(p.transformPoint(new Vec3(0, 0, -2.5)).z).toBeCloseTo(-0.5);
    expect(p.transformPoint(new Vec3(0, 0, -5)).z).toBeCloseTo(0);
    expect(p.transformPoint(new Vec3(0, 0, -7.5)).z).toBeCloseTo(0.5);
  });
});

describe("sanitizeShadowSize", () => {
  it("clamps and rounds to a power of two", () => {
    expect(sanitizeShadowSize(2048)).toBe(2048);
    expect(sanitizeShadowSize(1000)).toBe(1024);
    expect(sanitizeShadowSize(3000)).toBe(4096); // rounds to the nearest power of two
    expect(sanitizeShadowSize(2600)).toBe(2048);
    expect(sanitizeShadowSize(1)).toBe(MIN_SHADOW_SIZE);
    expect(sanitizeShadowSize(999999)).toBe(MAX_SHADOW_SIZE);
    expect(sanitizeShadowSize(NaN)).toBe(2048);
  });
});

describe("fitDirectionalShadow", () => {
  const base = { lightDir: LIGHT, center: new Vec3(4, 2, -6), radius: 40, mapSize: 2048 };

  it("keeps the center inside the map", () => {
    const fit = fitDirectionalShadow(base);
    const p = fit.matrix.transformPoint(fit.center);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
    expect(p.z).toBeGreaterThanOrEqual(-1);
    expect(p.z).toBeLessThanOrEqual(1);
  });

  it("reports world units per texel and covers the radius", () => {
    const fit = fitDirectionalShadow(base);
    expect(fit.texelWorld).toBeCloseTo((2 * 40) / 2048);
    // A point at the edge of the covered radius must still be in view.
    const edge = new Vec3(base.center.x + 40, base.center.y, base.center.z);
    const p = fit.matrix.transformPoint(edge);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(1.0001);
  });

  it("anchors the map to the world texel grid (no crawl)", () => {
    // The map is anchored to a world-anchored texel grid, so the requested
    // center can sit up to half a texel off the anchor - that offset is the
    // whole point. What must hold: the anchor itself is exactly on the grid,
    // and two centers inside the same texel produce the same map.
    const a = fitDirectionalShadow({ ...base, center: new Vec3(0, 0, 0) });
    const tiny = fitDirectionalShadow({ ...base, center: new Vec3(0.001, 0.001, 0.001) });
    for (const fit of [a, tiny]) {
      const n = fit.matrix.transformPoint(fit.snappedCenter);
      expect(Math.abs(n.x)).toBeLessThan(1e-6); // anchor exactly on-grid
      expect(Math.abs(n.y)).toBeLessThan(1e-6);
    }
    // Offsets stay under half a texel, so nothing leaves the map.
    const halfTexelNdc = 0.5 / a.texelWorld; // = 0.5 / (2*radius/size) ... in NDC
    for (const fit of [a, tiny]) {
      const n = fit.matrix.transformPoint(fit.center);
      expect(Math.abs(n.x)).toBeLessThan(halfTexelNdc);
      expect(Math.abs(n.y)).toBeLessThan(halfTexelNdc);
    }
    // Same texel -> identical map (the xy scale/translation that maps texels).
    const xyIdx = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13];
    for (const i of xyIdx) {
      expect(tiny.matrix.elements[i]).toBeCloseTo(a.matrix.elements[i], 9);
    }
    // Moving a full texel must move the map (snapping is not frozen).
    const moved = fitDirectionalShadow({ ...base, center: new Vec3(a.texelWorld, 0, 0) });
    expect(moved.matrix.elements[12]).not.toBeCloseTo(a.matrix.elements[12], 6);
  });

  it("handles a straight-down light without a degenerate up vector", () => {
    const fit = fitDirectionalShadow({ ...base, lightDir: new Vec3(0, -1, 0) });
    const p = fit.matrix.transformPoint(fit.center);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
  });

  it("tolerates a zero light direction", () => {
    const fit = fitDirectionalShadow({ ...base, lightDir: new Vec3(0, 0, 0) });
    expect(Number.isFinite(fit.matrix.elements[12])).toBe(true);
  });

  it("rejects a non-positive radius", () => {
    expect(() => fitDirectionalShadow({ ...base, radius: 0 })).toThrow();
  });
});

describe("sphereInsideShadow", () => {
  const fit = fitDirectionalShadow({ lightDir: LIGHT, center: new Vec3(0, 0, 0), radius: 20, mapSize: 1024 });

  it("accepts the center and nearby casters", () => {
    expect(sphereInsideShadow(fit.matrix, new Vec3(0, 0, 0), 1, fit.radius, fit.depthRange)).toBe(true);
    expect(sphereInsideShadow(fit.matrix, new Vec3(10, 0, 10), 2, fit.radius, fit.depthRange)).toBe(true);
  });

  it("rejects far-away casters", () => {
    expect(sphereInsideShadow(fit.matrix, new Vec3(500, 0, 0), 1, fit.radius, fit.depthRange)).toBe(false);
    expect(sphereInsideShadow(fit.matrix, new Vec3(0, 500, 0), 1, fit.radius, fit.depthRange)).toBe(false);
  });

  it("accepts a caster whose radius reaches the box", () => {
    expect(sphereInsideShadow(fit.matrix, new Vec3(60, 0, 0), 45, fit.radius, fit.depthRange)).toBe(true);
  });
});

describe("bias math", () => {
  it("increases with grazing light and texel size", () => {
    const headOn = shadowDepthBias(1, 0.05, 100, 0.001, 2);
    const grazing = shadowDepthBias(0.05, 0.05, 100, 0.001, 2);
    expect(grazing).toBeGreaterThan(headOn);
    const coarse = shadowDepthBias(0.5, 0.2, 100, 0.001, 2);
    expect(coarse).toBeGreaterThan(shadowDepthBias(0.5, 0.02, 100, 0.001, 2));
  });

  it("scales down as the depth range grows", () => {
    expect(shadowDepthBias(0.2, 0.05, 500, 0.001, 2)).toBeLessThan(shadowDepthBias(0.2, 0.05, 50, 0.001, 2));
  });

  it("offsets along the normal, growing at grazing angles", () => {
    const n = new Vec3(0, 1, 0);
    const facing = normalOffsetWorld(n, LIGHT, 0.05, 2);
    expect(facing.y).toBeGreaterThan(0);
    const grazing = normalOffsetWorld(new Vec3(1, 0, 0), LIGHT, 0.05, 2);
    const facingMag = facing.length();
    expect(grazing.length()).toBeGreaterThan(facingMag);
  });
});

describe("shadowSample reference", () => {
  const occ = [{ u: 0.5, v: 0.5, d: 0.4 }];

  it("reports shadow when the occluder is closer than the reference", () => {
    expect(shadowSample(occ, 0.5, 0.5, 0.6, 0)).toBe(0);
  });

  it("reports lit when the reference is in front of the occluder", () => {
    expect(shadowSample(occ, 0.5, 0.5, 0.2, 0)).toBe(1);
  });

  it("ignores occluders outside the filter radius", () => {
    expect(shadowSample(occ, 0.6, 0.5, 0.6, 0)).toBe(1);
    expect(shadowSample(occ, 0.51, 0.5, 0.6, 0.02)).toBe(0);
  });
});

describe("pcfKernel", () => {
  it("is deterministic, bounded, and ordered by radius", () => {
    const a = pcfKernel(8, 2);
    expect(a).toEqual(pcfKernel(8, 2));
    expect(a).toHaveLength(8);
    for (const p of a) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(2 + 1e-9);
    const radii = a.map((p) => Math.hypot(p.x, p.y));
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThanOrEqual(radii[i - 1] - 1e-9);
  });

  it("clamps sample count", () => {
    expect(pcfKernel(0, 1)).toHaveLength(1);
    expect(pcfKernel(1000, 1)).toHaveLength(64);
  });
});
