import { describe, expect, it } from "vitest";
import { Vec3 } from "../src/math/vec3.js";
import {
  DEFAULT_LOD_HYSTERESIS, LODTracker, buildLODChain, distanceTo, lodCulled, normalizeChain,
  screenCoverage, selectLOD, type LODLevel,
} from "../src/rendering/lod.js";

const FOV = (60 * Math.PI) / 180;

function chain(...pairs: [string, number][]): LODLevel[] {
  return pairs.map(([meshId, coverage]) => ({ meshId, coverage }));
}

describe("screenCoverage", () => {
  it("grows as the object gets closer", () => {
    expect(screenCoverage(1, 10, FOV)).toBeGreaterThan(screenCoverage(1, 100, FOV));
  });

  it("clamps into 0..1", () => {
    expect(screenCoverage(1, 0.0001, FOV)).toBe(1);
    expect(screenCoverage(1, 1e9, FOV)).toBeLessThan(1e-6);
  });

  it("matches the projected half-height at 90 degrees", () => {
    // tan(45) = 1, so the coverage of radius r at distance d is r/d.
    expect(screenCoverage(2, 8, Math.PI / 2)).toBeCloseTo(0.25, 6);
  });

  it("falls off linearly with distance", () => {
    const a = screenCoverage(1, 10, FOV);
    const b = screenCoverage(1, 20, FOV);
    expect(b).toBeCloseTo(a / 2, 6);
  });
});

describe("normalizeChain", () => {
  it("sorts descending and drops duplicate thresholds", () => {
    const n = normalizeChain([
      { meshId: "c", coverage: 0.1 },
      { meshId: "a", coverage: 0.6 },
      { meshId: "b", coverage: 0.6 },
    ]);
    expect(n.map((l) => l.meshId)).toEqual(["a", "c"]);
  });

  it("ignores non-finite thresholds", () => {
    expect(normalizeChain([{ meshId: "a", coverage: NaN }])).toHaveLength(0);
  });
});

describe("selectLOD", () => {
  /** Distance at which a unit-radius object has the given coverage. */
  const dFor = (cov: number): number => 1 / (cov * Math.tan(FOV * 0.5));

  it("picks the coarsest level the object still meets", () => {
    const levels = chain(["lod0", 0.6], ["lod1", 0.25], ["lod2", 0.1]);
    expect(selectLOD(levels, 1, dFor(0.8), FOV)).toBe(0);
    expect(selectLOD(levels, 1, dFor(0.3), FOV)).toBe(1);
    expect(selectLOD(levels, 1, dFor(0.05), FOV)).toBe(2);
  });

  it("is scale aware: a bigger object keeps detail longer", () => {
    const levels = chain(["lod0", 0.6], ["lod1", 0.25]);
    const d = dFor(0.4);
    expect(selectLOD(levels, 1, d, FOV)).toBe(1);
    // Same distance, 2x the radius -> double the coverage -> LOD0 again.
    expect(selectLOD(levels, 2, d, FOV)).toBe(0);
  });

  it("falls back to the last level when everything is tiny", () => {
    const levels = chain(["a", 0.6], ["b", 0.2]);
    expect(selectLOD(levels, 1, 1000, FOV)).toBe(1);
  });

  it("returns -1 for an empty chain", () => {
    expect(selectLOD([], 1, 5, FOV)).toBe(-1);
  });

  it("keeps the current level inside the hysteresis band", () => {
    const levels = chain(["a", 0.5], ["b", 0.2]);
    // Just below 0.5 -> LOD1 by threshold...
    const d = dFor(0.49);
    expect(selectLOD(levels, 1, d, FOV)).toBe(1);
    // ...but if LOD0 was already active, hysteresis keeps it.
    expect(selectLOD(levels, 1, d, FOV, 0)).toBe(0);
    // Only once coverage clears the 0.5 threshold by the band does it switch.
    expect(selectLOD(levels, 1, dFor(0.4), FOV, 0)).toBe(1);
  });

  it("delays a step up by the band too", () => {
    const levels = chain(["a", 0.53], ["b", 0.52]);
    // Coverage 0.55 crosses LOD0's 0.53 threshold but not the band above it.
    expect(selectLOD(levels, 1, dFor(0.55), FOV, 1)).toBe(1);
    expect(selectLOD(levels, 1, dFor(0.55), FOV, 1, 0)).toBe(0);
    // Well outside the band -> the step up happens.
    expect(selectLOD(levels, 1, dFor(0.9), FOV, 1)).toBe(0);
  });

  it("treats a zero hysteresis band as pure threshold selection", () => {
    const levels = chain(["a", 0.5], ["b", 0.2]);
    for (const cov of [0.9, 0.5, 0.3, 0.1]) {
      const d = dFor(cov);
      const fresh = selectLOD(levels, 1, d, FOV, -1, 0);
      expect(selectLOD(levels, 1, d, FOV, 0, 0)).toBe(fresh);
      expect(selectLOD(levels, 1, d, FOV, 1, 0)).toBe(fresh);
    }
  });

  it("honours a custom hysteresis", () => {
    const levels = chain(["a", 0.5], ["b", 0.2]);
    const d = dFor(0.49);
    expect(selectLOD(levels, 1, d, FOV, 0, 0)).toBe(1);
    expect(selectLOD(levels, 1, d, FOV, 0, 0.2)).toBe(0);
  });

  it("does not flicker at a boundary when called repeatedly", () => {
    const levels = chain(["a", 0.5], ["b", 0.2]);
    const d = dFor(0.5);
    let level = -1;
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) level = selectLOD(levels, 1, d, FOV, level);
    seen.add(level);
    expect(seen.size).toBe(1);
    expect(DEFAULT_LOD_HYSTERESIS).toBeGreaterThan(0);
  });
});

describe("lodCulled", () => {
  it("culls below the floor only when a floor is set", () => {
    const withFloor = chain(["a", 0.5]);
    withFloor[0].cullBelow = 0.02;
    expect(lodCulled(withFloor, 1, 1000, FOV)).toBe(true);
    expect(lodCulled(withFloor, 1, 10, FOV)).toBe(false);
    const noFloor = chain(["a", 0.5]);
    expect(lodCulled(noFloor, 1, 1000, FOV)).toBe(false);
  });

  it("uses the highest floor when several levels declare one", () => {
    const levels: LODLevel[] = [
      { meshId: "a", coverage: 0.5, cullBelow: 0.01 },
      { meshId: "b", coverage: 0.2, cullBelow: 0.05 },
    ];
    expect(lodCulled(levels, 1, 30, FOV)).toBe(false);
    expect(lodCulled(levels, 1, 400, FOV)).toBe(true);
  });
});

describe("buildLODChain", () => {
  it("pairs mesh ids with descending coverages and shrinking radii", () => {
    const c = buildLODChain(["hi", "mid", "lo", "min"]);
    expect(c.levels.map((l) => l.meshId)).toEqual(["hi", "mid", "lo", "min"]);
    expect(c.levels[0].coverage).toBeGreaterThan(c.levels[3].coverage);
    expect(c.radiusScale[0]).toBe(1);
    expect(c.radiusScale[1]).toBeCloseTo(0.5);
    expect(c.radiusScale[3]).toBeCloseTo(0.125);
  });

  it("clamps to the mesh count and always keeps LOD0", () => {
    expect(buildLODChain(["only"]).levels).toHaveLength(1);
    expect(buildLODChain([]).levels).toHaveLength(1);
    expect(buildLODChain(["a", "b", "c", "d", "e"], { coverages: [0.6, 0.2] }).levels).toHaveLength(2);
  });

  it("puts the cull floor on the last level only", () => {
    const c = buildLODChain(["a", "b"], { cullBelow: 0.01 });
    expect(c.levels[0].cullBelow).toBeUndefined();
    expect(c.levels[1].cullBelow).toBe(0.01);
    expect(c.cullBelow).toBe(0.01);
  });
});

describe("LODTracker", () => {
  it("returns the right mesh and reports changes once", () => {
    const t = new LODTracker();
    const levels = buildLODChain(["hi", "mid", "lo"], { cullBelow: null }).levels;
    const cam = new Vec3(0, 0, 0);
    const near = t.resolve(1, levels, 1, new Vec3(1, 1, 1), cam, new Vec3(0, 0, -2), FOV)!;
    expect(near.meshId).toBe("hi");
    expect(t.changed.has(1)).toBe(true);
    t.changed.clear();
    const again = t.resolve(1, levels, 1, new Vec3(1, 1, 1), cam, new Vec3(0, 0, -2), FOV)!;
    expect(again.level).toBe(near.level);
    expect(t.changed.size).toBe(0);
    const far = t.resolve(1, levels, 1, new Vec3(1, 1, 1), cam, new Vec3(0, 0, -40), FOV)!;
    expect(far.meshId).not.toBe("hi");
    expect(t.changed.has(1)).toBe(true);
  });

  it("scales the radius by the largest axis", () => {
    const t = new LODTracker();
    const levels = buildLODChain(["hi", "lo"], { cullBelow: null }).levels;
    const r = t.resolve(1, levels, 1, new Vec3(3, 1, 1), new Vec3(0, 0, 0), new Vec3(0, 0, -5), FOV)!;
    expect(r.radius).toBeCloseTo(3);
  });

  it("culls when the chain has a floor", () => {
    const t = new LODTracker();
    const levels = buildLODChain(["hi", "lo"], { cullBelow: 0.05 }).levels;
    expect(t.resolve(1, levels, 1, new Vec3(1, 1, 1), new Vec3(0, 0, 0), new Vec3(0, 0, -500), FOV)).toBeNull();
    expect(t.resolve(1, levels, 1, new Vec3(1, 1, 1), new Vec3(0, 0, 0), new Vec3(0, 0, -3), FOV)).not.toBeNull();
  });

  it("forgets and clears per-entity state", () => {
    const t = new LODTracker();
    const levels = buildLODChain(["hi", "lo"], { cullBelow: null }).levels;
    t.resolve(7, levels, 1, new Vec3(1, 1, 1), new Vec3(0, 0, 0), new Vec3(0, 0, -50), FOV);
    t.changed.clear();
    // Forgetting the entity re-evaluates it from scratch (reported again).
    t.forget(7);
    t.resolve(7, levels, 1, new Vec3(1, 1, 1), new Vec3(0, 0, 0), new Vec3(0, 0, -50), FOV);
    expect(t.changed.has(7)).toBe(true);
    t.clear();
    expect(t.changed.size).toBe(0);
  });

  it("drops the remembered level once an entity is culled", () => {
    const t = new LODTracker();
    const levels = buildLODChain(["hi", "lo"], { cullBelow: 0.05 }).levels;
    const cam = new Vec3(0, 0, 0);
    t.resolve(3, levels, 1, new Vec3(1, 1, 1), cam, new Vec3(0, 0, -3), FOV);
    t.changed.clear();
    expect(t.resolve(3, levels, 1, new Vec3(1, 1, 1), cam, new Vec3(0, 0, -500), FOV)).toBeNull();
    // Coming back close re-evaluates from scratch (reported as a change).
    t.resolve(3, levels, 1, new Vec3(1, 1, 1), cam, new Vec3(0, 0, -3), FOV);
    expect(t.changed.has(3)).toBe(true);
  });
});

describe("distanceTo", () => {
  it("is the plain euclidean distance", () => {
    expect(distanceTo(new Vec3(0, 0, 0), new Vec3(3, 4, 0))).toBeCloseTo(5);
  });
});
