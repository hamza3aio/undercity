import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { makeTransform } from "../src/ecs/components.js";
import { parkHill, PARK_CENTER } from "../src/game/world/city.js";
import { sampleHeight } from "../src/world/terrain.js";
import { bakeNavmesh, findPath } from "../src/ai/navmesh.js";
import { ParticleSystem } from "../src/fx/particles.js";
import { ScriptRuntime } from "../src/script/script.js";
import { Vec3 } from "../src/math/vec3.js";
import { reachCheck, reachEntity } from "../src/game/world/reach.js";

describe("Overlook Park hill (v0.7 terrain)", () => {
  it("is deterministic across builds", () => {
    const a = parkHill();
    const b = parkHill();
    expect(a.heights).toEqual(b.heights);
    expect(a.size).toBe(11);
  });

  it("has real relief at the park center offset", () => {
    const h = parkHill();
    expect(sampleHeight(h, 0, 0)).toBeGreaterThan(1);
    expect(PARK_CENTER).toEqual([42, 32]);
  });
});

describe("navmesh walkability (v0.7 walkers)", () => {
  it("paths across an empty district", () => {
    const world = new World();
    const g = bakeNavmesh(world, { minX: -60, maxX: 60, minZ: -60, maxZ: 60, cell: 2 });
    const path = findPath(g, 0, 0, 20, 0);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(1);
    expect(Math.abs(path![path!.length - 1].x - 20)).toBeLessThanOrEqual(2);
  });
});

describe("particles (v0.7 fx)", () => {
  it("bursts then settles", () => {
    const world = new World();
    const fx = new ParticleSystem(world, 64);
    const n = fx.burst({
      rate: 0, burst: 0, duration: 0, looping: false,
      life: [0.4, 0.9], speed: [1.5, 4.5], direction: new Vec3(0, 1, 0), spread: 0.9,
      size: [0.07, 0.14], growth: -0.02,
      colorStart: [0.4, 0.9, 0.4], colorEnd: [1, 1, 1],
      gravity: -5, drag: 0.6, bounce: 0.4, meshId: "cube",
    }, 0, 1, 0, 10);
    expect(n).toBe(10);
    expect(fx.aliveCount).toBe(10);
    fx.update(5);
    expect(fx.aliveCount).toBe(0);
  });
});

describe("beacon script (v0.7 lua)", () => {
  it("attaches and pulses without errors", () => {
    const world = new World();
    const e = world.create();
    world.add(e, "transform", makeTransform(14, 2, -12));
    const rt = new ScriptRuntime(world);
    const ok = rt.attach(e, [
      "local S = { t = 0, baseY = 2 }",
      "function S.start(api, dt) S.baseY = api.getY() end",
      "function S.update(api, dt) S.t = S.t + dt",
      "api.setPos(api.getX(), S.baseY + math.sin(S.t * 2) * 0.15, api.getZ()) end",
      "return S",
    ].join("\n"), "beacon-pulse");
    expect(ok).toBe(true);
    for (let i = 0; i < 60; i++) rt.update(1 / 60);
    expect(rt.errors).toEqual([]);
    const t = world.get<ReturnType<typeof makeTransform>>(e, "transform")!;
    expect(t.position.y).toBeCloseTo(2, 0);
  });
});
