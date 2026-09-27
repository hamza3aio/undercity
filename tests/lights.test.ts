import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeTransform } from "../src/ecs/components.js";
import {
  MAX_POINT_LIGHTS, coneCosine, distanceAttenuation, makeSpot, rankLights, sanitizeSpot, spotAttenuation,
} from "../src/rendering/lights.js";
import { LightSystem, rotateY } from "../src/rendering/lightsystem.js";

function fakeRenderer() {
  return { pointLights: [], spotLights: [] } as never as import("../src/rendering/renderer.js").Renderer;
}

describe("distanceAttenuation", () => {
  it("keeps the old inverse-square shape and cuts off at the range", () => {
    expect(distanceAttenuation(0, 20)).toBeCloseTo(1);
    // Well inside the range the cutoff barely changes the old curve.
    expect(distanceAttenuation(4, 20)).toBeLessThan(1 / (1 + 0.25 * 16));
    expect(distanceAttenuation(4, 20)).toBeGreaterThan(0.9 * (1 / (1 + 0.25 * 16)));
    expect(distanceAttenuation(20, 20)).toBe(0);
    expect(distanceAttenuation(50, 20)).toBe(0);
  });

  it("decreases monotonically with distance", () => {
    let prev = Infinity;
    for (let d = 0; d < 20; d += 0.5) {
      const a = distanceAttenuation(d, 20);
      expect(a).toBeLessThanOrEqual(prev + 1e-12);
      prev = a;
    }
  });
});

describe("spotAttenuation", () => {
  const ci = Math.cos(0.4), co = Math.cos(0.7);
  it("is 1 inside, 0 outside, and ramps between", () => {
    expect(spotAttenuation(1, ci, co)).toBe(1);
    expect(spotAttenuation(co, ci, co)).toBe(0);
    expect(spotAttenuation(0, ci, co)).toBe(0);
    const mid = (ci + co) / 2;
    expect(spotAttenuation(mid, ci, co)).toBeCloseTo(0.5, 6);
  });

  it("degenerates to a hard edge when the angles match", () => {
    // No ramp exists, so the cone is binary: on above the angle, off at/below.
    expect(spotAttenuation(0.6, 0.5, 0.5)).toBe(1);
    expect(spotAttenuation(0.5, 0.5, 0.5)).toBe(0);
    expect(spotAttenuation(0.4, 0.5, 0.5)).toBe(0);
  });
});

describe("coneCosine", () => {
  it("is 1 straight down the axis and negative behind it", () => {
    const axis = new Vec3(0, -1, 0);
    expect(coneCosine(axis, new Vec3(0, -5, 0))).toBeCloseTo(1);
    expect(coneCosine(axis, new Vec3(0, 5, 0))).toBeCloseTo(-1);
    expect(coneCosine(axis, new Vec3(5, 0, 0))).toBeCloseTo(0);
  });

  it("is scale independent", () => {
    const axis = new Vec3(0, -1, 0);
    expect(coneCosine(axis, new Vec3(0, -2, 0))).toBeCloseTo(coneCosine(axis, new Vec3(0, -20, 0)), 6);
  });
});

describe("makeSpot / sanitizeSpot", () => {
  it("builds a sane default and orders the angles", () => {
    const s = makeSpot({ innerDegrees: 50, outerDegrees: 20 });
    expect(s.outerAngle).toBeGreaterThanOrEqual(s.innerAngle);
    expect(s.direction.length()).toBeCloseTo(1);
  });

  it("clamps junk", () => {
    const s = sanitizeSpot({
      position: new Vec3(), direction: new Vec3(0, -3, 0), color: [1, 1, 1],
      intensity: -5, range: 0, innerAngle: 99, outerAngle: 99,
    });
    expect(s.intensity).toBe(0);
    expect(s.range).toBeGreaterThan(0);
    expect(s.outerAngle).toBeLessThanOrEqual(Math.PI / 2);
    expect(s.innerAngle).toBeLessThanOrEqual(s.outerAngle);
    expect(s.direction.length()).toBeCloseTo(1);
  });
});

describe("rankLights", () => {
  const p = (x: number, y: number, z: number, intensity = 1, range = 20) => ({
    position: new Vec3(x, y, z), color: [1, 1, 1] as [number, number, number], intensity, range,
  });

  it("keeps the brightest at the reference point", () => {
    const ref = new Vec3(0, 0, 0);
    const near = p(0, 2, 0, 1, 20);
    const far = p(15, 0, 0, 1, 20);
    const r = rankLights([near, far], ["point", "point"], ref, 4);
    expect(r[0].index).toBe(0);
  });

  it("respects the cap and returns [] when everything is out of range", () => {
    const r = rankLights([p(0, 0, 1), p(0, 0, 2), p(0, 0, 3)], ["point", "point", "point"], new Vec3(0, 0, 0), 2);
    expect(r).toHaveLength(2);
    const none = rankLights([p(500, 0, 0)], ["point"], new Vec3(0, 0, 0), 4);
    expect(none).toEqual([]);
  });

  it("zeroes spots whose cone misses the reference point", () => {
    const s = makeSpot({ position: new Vec3(0, 5, 0), direction: new Vec3(0, 1, 0), intensity: 5, range: 20 });
    const r = rankLights([s], ["spot"], new Vec3(0, 0, 0), 4);
    expect(r).toEqual([]); // pointing away from the floor
  });

  it("breaks ties on index (deterministic)", () => {
    const a = p(0, 0, 1), b = p(0, 0, 1);
    expect(rankLights([a, b], ["point", "point"], new Vec3(0, 0, 0), 2).map((x) => x.index)).toEqual([0, 1]);
  });
});

describe("rotateY", () => {
  it("matches the renderer's yaw convention", () => {
    const r = rotateY([0, 0, 1], Math.PI / 2);
    expect(r.x).toBeCloseTo(1);
    expect(r.z).toBeCloseTo(0);
    expect(r.y).toBe(0);
  });
});

describe("LightSystem", () => {
  it("collects point and spot components, culling disabled lights", () => {
    const world = new World();
    const renderer = fakeRenderer();
    const sys = new LightSystem(world, renderer);
    const a = world.create();
    world.add(a, "transform", makeTransform(0, 3, 0));
    world.add(a, "light", { kind: "point", color: [1, 1, 1], intensity: 1, range: 10, direction: [0, -1, 0], innerAngle: 0.4, outerAngle: 0.7, on: true });
    const b = world.create();
    world.add(b, "transform", makeTransform(5, 3, 0));
    world.add(b, "light", { kind: "spot", color: [1, 0.8, 0.5], intensity: 2, range: 12, direction: [0, -1, 0], innerAngle: 0.4, outerAngle: 0.7, on: true });
    const c = world.create();
    world.add(c, "transform", makeTransform(9, 3, 0));
    world.add(c, "light", { kind: "point", color: [1, 1, 1], intensity: 0, range: 10, direction: [0, -1, 0], innerAngle: 0.4, outerAngle: 0.7, on: false });

    const r = sys.sync();
    expect(r).toEqual({ points: 1, spots: 1, culled: 1 });
    expect(renderer.pointLights).toHaveLength(1);
    expect(renderer.spotLights).toHaveLength(1);
    expect(renderer.spotLights[0].direction.y).toBeCloseTo(-1);
  });

  it("rotates the spot aim with the entity yaw", () => {
    const world = new World();
    const renderer = fakeRenderer();
    const sys = new LightSystem(world, renderer);
    const e = sys.addLight("spot", 0, 4, 0, { direction: [0, 0, 1] });
    world.get<{ rotationY: number }>(e, "transform")!.rotationY = Math.PI / 2;
    sys.sync();
    expect(renderer.spotLights[0].direction.x).toBeCloseTo(1);
    expect(renderer.spotLights[0].direction.z).toBeCloseTo(0);
  });

  it("addLight uses the component defaults", () => {
    const world = new World();
    const sys = new LightSystem(world, fakeRenderer());
    const e = sys.addLight("point", 1, 2, 3);
    const l = world.get<{ range: number; on: boolean }>(e, "light")!;
    expect(l.range).toBeGreaterThan(0);
    expect(l.on).toBe(true);
    expect(world.get<{ position: Vec3 }>(e, "transform")!.position.y).toBe(2);
  });
});

describe("light slot budget", () => {
  it("the renderer uploads a fixed 4 slots", () => {
    expect(MAX_POINT_LIGHTS).toBe(4);
  });
});
